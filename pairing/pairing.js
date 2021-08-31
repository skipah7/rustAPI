const express = require('express')
const https = require('https')
const chromeLauncher = require('chrome-launcher')
const { v4: uuidv4 } = require('uuid')
const { register, listen } = require('push-receiver')
const path = require('path')
const fs = require('fs')

function getConfig () {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'rustAPIconfig.json')))
  } catch (error) {
    return {}
  }
}

/**
 * Adding new info (updateConfig) to the current info (currentConfig)
 * @param currentConfig
 * @param updateConfig
 */
function updateConfig (currentConfig, updateConfig) {
  const updatedConfig = JSON.stringify({ ...currentConfig, ...updateConfig }, null, '\t')

  fs.writeFileSync(path.join(__dirname, 'rustAPIconfig.json'), updatedConfig)
}

async function getExpoPushToken (deviceToken) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      type: 'fcm',
      deviceId: uuidv4(),
      development: false,
      experienceId: '@facepunch/RustCompanion',
      appId: 'com.facepunch.rust.companion',
      deviceToken: deviceToken
    })

    const options = {
      hostname: 'exp.host',
      path: '/--/api/v2/push/getExpoPushToken',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    }

    const request = https.request(options, (response) => {
      console.log('POST to exp.host. Status code: ' + response.statusCode)

      response.on('data', (responseData) => {
        const expoPushToken = JSON.parse(responseData).data.expoPushToken

        resolve(expoPushToken)
      })
    })

    request.write(data)
    request.end()
  })
}

let fcmListener
let httpServer
async function getAuthToken () {
  return new Promise((resolve, reject) => {
    const application = express()
    const APPLICATION_PORT = 5000

    application.get('/', (request, response) => {
      response.sendFile(path.join(__dirname, 'rustlogin.html'))
    })

    application.get('/loginCompleted', async (request, response) => {
      await chromeLauncher.killAll()

      const authToken = request.query.authToken

      if (authToken) {
        resolve(authToken)
      } else {
        reject(new Error('Token was not received'))
      }

      httpServer.close()
    })

    httpServer = application.listen(APPLICATION_PORT, async () => {
      await chromeLauncher.launch({
        startingUrl: `http://localhost:${APPLICATION_PORT}`,
        ignoreDefaultFlags: true,
        handleSIGINT: false,
        chromeFlags: [
          '--disable-web-security',
          '--disable-popup-blocking',
          '--disable-site-isolation-trials'
        ]
      }).catch((error) => {
        console.error(error)
      })
    })
  })
}

async function rustplusRegister (authToken, expoPushToken) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      AuthToken: authToken,
      DeviceId: 'rustAPI.js',
      PushKind: 0,
      PushToken: expoPushToken
    })

    const options = {
      hostname: 'companion-rust.facepunch.com',
      path: '/api/push/register',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    }

    const request = https.request(options, (response) => {
      console.log('POST to companion-rust.facepunch.com. Status code: ' + response.statusCode)

      response.on('data', (responseData) => {
        const newAuthToken = JSON.parse(responseData).token

        resolve(newAuthToken)
      })
    })

    request.write(data)
    request.end()
  })
}

async function pushNotificationRegister (config) {
  console.log('Registering with rust+ senderID')

  const facepunchSenderID = '976529667804'
  const credentials = await register(facepunchSenderID)
  const fcmToken = credentials.fcm.token
  console.log(`Fetched fcmToken: ${fcmToken}\n`)

  // get authToken via facepunch website
  let authToken = await getAuthToken()
  console.log(`Fetched authToken: ${authToken}\n`)

  // get expoPushToken for this device
  const expoPushToken = await getExpoPushToken(fcmToken)
  console.log(`Fetched expoPushToken: ${expoPushToken}\n`)

  console.log('Registering with expoPushToken and authToken via facepunch API')
  authToken = await rustplusRegister(authToken, expoPushToken)
  console.log(`Refreshed auth token: ${authToken}\n`)

  // write received info in config
  updateConfig(config, {
    fcmCredentials: credentials,
    expoPushToken: expoPushToken,
    authToken: authToken
  })
}

async function stopEverything () {
  await chromeLauncher.killAll()

  if (httpServer) httpServer.close()

  if (fcmListener) fcmListener.destroy()
}

async function pushNotificationListen () {
  // check if there is necessary register info in config file
  let config = getConfig()

  // if not, go through register flow and get necessary info
  if (!(config.fcmCredentials && config.expoPushToken && config.authToken)) {
    console.log('You are missing some credentials, starting registration')

    await pushNotificationRegister(config)
    config = getConfig()
  }

  fcmListener = await listen(config.fcmCredentials, ({ notification, persistentId }) => {
    console.log('Notifications ID: ' + persistentId)
    console.log(notification)

    console.log(JSON.parse(notification.data.body))
  })

  console.log('Listening for push notifications')
}

process.on('SIGINT', stopEverything)
process.on('SIGTERM', stopEverything)

pushNotificationListen()
