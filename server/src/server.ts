import consola from 'consola'

import { ServerEvents, ClientEvents } from '../../common-types/events'
import { Device } from './driver/Device'
import { DeviceDriver } from './driver/Driver'
import { DeviceInputData } from '../../common-types/device'
import { clamp, mapValues } from 'lodash'

const SECOND_AS_NS = BigInt(1e9)
const INPUT_EVENT_SEND_NS = SECOND_AS_NS / BigInt(20) // 20hz
const INPUT_EVENTS_REQUIRED_FOR_CALIBRATION = 250

interface Params {
  expressApplication: Express.Application
  socketIOServer: SocketIO.Server
  deviceDrivers: DeviceDriver[]
}

type DeviceData = {
  id: string
  device: Device
  inputEventTracker: {
    lastSent: bigint
    accumulatedInputData: DeviceInputData | null
  }
  calibration: CalibrationStatus
}

// null = not calibrating
type CalibrationStatus = {
  calibrationBuffer: number
  inputEventsCalculated: number
  currentSensorValueAverage: number[] | null // null = no data yet
} | null

const createServer = (params: Params) => {
  const deviceDataById: {
    [deviceId: string]: DeviceData
  } = {}

  /* Handlers */

  const getDevicesUpdatedEvent = (): ServerEvents.DevicesUpdated => ({
    devices: mapValues(deviceDataById, deviceData => ({
      id: deviceData.id,
      configuration: deviceData.device.configuration,
      properties: deviceData.device.properties,
      calibration: deviceData.calibration
        ? {
            calibrationBuffer: deviceData.calibration.calibrationBuffer
          }
        : null
    }))
  })

  const broadcastDevicesUpdated = () => {
    params.socketIOServer.emit('devicesUpdated', getDevicesUpdatedEvent())
  }

  const handleNewDevice = (device: Device) => {
    deviceDataById[device.id] = {
      id: device.id,
      device: device,
      inputEventTracker: {
        lastSent: BigInt(0),
        accumulatedInputData: null
      },
      calibration: null
    }

    device.on('disconnect', () => handleDisconnectDevice(device.id))
    device.on('inputData', data => handleInputData(device.id, data))
    device.on('eventRate', number => handleEventRate(device.id, number))

    broadcastDevicesUpdated()

    consola.info(`Connected to a new device id "${device.id}"`, {
      properties: device.properties,
      configuration: device.configuration
    })
  }

  const handleDisconnectDevice = (deviceId: string) => {
    delete deviceDataById[deviceId]
    broadcastDevicesUpdated()
    consola.info(`Disconnected from device id "${deviceId}"`)
  }

  const doCalibrationTick = async (deviceData: DeviceData, inputData: DeviceInputData) => {
    const { device, calibration } = deviceData

    // Calibration not active, do nothing.
    if (calibration === null) {
      return
    }

    if (calibration.currentSensorValueAverage === null) {
      calibration.currentSensorValueAverage = [...inputData.sensors]
    } else {
      // Update cumulative moving average. If not familiar:
      // https://en.wikipedia.org/wiki/Moving_average#Cumulative_moving_average
      for (let sensorIndex = 0; sensorIndex < device.properties.sensorCount; sensorIndex++) {
        const oldAverage = calibration.currentSensorValueAverage[sensorIndex]
        const newValue = inputData.sensors[sensorIndex]
        const newAverage =
          oldAverage + (newValue - oldAverage) / (calibration.inputEventsCalculated + 1)
        calibration.currentSensorValueAverage[sensorIndex] = newAverage
      }
    }

    calibration.inputEventsCalculated++

    // Have we enough data to update?
    if (calibration.inputEventsCalculated > INPUT_EVENTS_REQUIRED_FOR_CALIBRATION) {
      const sensorThresholds = calibration.currentSensorValueAverage.map(value =>
        clamp(value + calibration.calibrationBuffer, 0, 1)
      )

      // Remove calibration and update new values.
      deviceData.calibration = null
      await device.updateConfiguration({ sensorThresholds })
      await device.saveConfiguration()
      broadcastDevicesUpdated()
    }
  }

  const doSendInputEventToClient = (data: DeviceData, inputData: DeviceInputData) => {
    const inputEventTracker = data.inputEventTracker
    const now = process.hrtime.bigint()

    if (inputEventTracker.accumulatedInputData === null) {
      // first time receiving sensor values since sending an input event?
      inputEventTracker.accumulatedInputData = {
        sensors: [...inputData.sensors],
        buttons: [...inputData.buttons]
      }
    } else {
      // merge input data to accumulated input data so far.
      const inputData = inputEventTracker.accumulatedInputData

      // during accumulation, get the maximum sensor values of all input events received.
      for (let sensorIndex = 0; sensorIndex < data.device.properties.sensorCount; sensorIndex++) {
        inputEventTracker.accumulatedInputData.sensors[sensorIndex] = Math.max(
          inputData.sensors[sensorIndex],
          inputEventTracker.accumulatedInputData.sensors[sensorIndex]
        )
      }

      // during accumulation, show button as pressed if it was pressed at any time during input
      // events.
      for (let buttonIndex = 0; buttonIndex < data.device.properties.buttonCount; buttonIndex++) {
        inputEventTracker.accumulatedInputData.buttons[buttonIndex] =
          inputData.buttons[buttonIndex] ||
          inputEventTracker.accumulatedInputData.buttons[buttonIndex]
      }
    }

    // if we need to still to wait before sending an input event, do nothing.
    if (inputEventTracker.lastSent + INPUT_EVENT_SEND_NS > now) {
      return
    }

    const event: ServerEvents.InputEvent = {
      deviceId: data.id,
      inputData: inputEventTracker.accumulatedInputData
    }

    params.socketIOServer.volatile.to(data.id).emit('inputEvent', event)

    inputEventTracker.lastSent = now
    inputEventTracker.accumulatedInputData = null
  }

  const handleInputData = async (deviceId: string, inputData: DeviceInputData) => {
    const deviceData = deviceDataById[deviceId]
    doSendInputEventToClient(deviceData, inputData)
    await doCalibrationTick(deviceData, inputData)
  }

  const handleEventRate = (deviceId: string, rate: number) => {
    const event: ServerEvents.EventRate = { deviceId: deviceId, eventRate: rate }
    params.socketIOServer.to(deviceId).emit('eventRate', event)
  }

  /* Start server. */

  params.deviceDrivers.forEach(dd => {
    dd.on('newDevice', handleNewDevice)
    dd.start()
  })

  params.socketIOServer.on('connection', socket => {
    consola.info('New SocketIO connection from', socket.handshake.address)
    socket.emit('devicesUpdated', getDevicesUpdatedEvent())

    socket.on('subscribeToDevice', (data: ClientEvents.SubscribeToDevice) => {
      consola.info(`Socket "${socket.handshake.address}" subscribed to device "${data.deviceId}"`)
      socket.join(data.deviceId)
    })

    socket.on('unsubscribeFromDevice', (data: ClientEvents.UnsubscribeFromDevice) => {
      consola.info(
        `Socket "${socket.handshake.address}" unsubscribed from device "${data.deviceId}"`
      )
      socket.leave(data.deviceId)
    })

    socket.on('updateConfiguration', async (data: ClientEvents.UpdateConfiguration) => {
      const device = deviceDataById[data.deviceId].device

      await device.updateConfiguration(data.configuration)
      if (data.store) {
        await device.saveConfiguration()
      }
      broadcastDevicesUpdated()

      consola.info(`Device id "${data.deviceId}" configuration updated`, data.configuration)
    })

    socket.on('saveConfiguration', async (data: ClientEvents.SaveConfiguration) => {
      await deviceDataById[data.deviceId].device.saveConfiguration()
    })

    socket.on('updateSensorThreshold', async (data: ClientEvents.UpdateSensorThreshold) => {
      const { device } = deviceDataById[data.deviceId]
      const sensorThresholds = [...device.configuration.sensorThresholds]
      sensorThresholds[data.sensorIndex] = data.newThreshold

      await device.updateConfiguration({ sensorThresholds })
      if (data.store) {
        await device.saveConfiguration()
      }
      broadcastDevicesUpdated()

      consola.info(
        `Device id "${data.deviceId}" had sensor ${data.sensorIndex} threshold changed to ${data.newThreshold}`
      )
    })

    socket.on('calibrate', async (data: ClientEvents.Calibrate) => {
      const deviceData = deviceDataById[data.deviceId]

      deviceData.calibration = {
        calibrationBuffer: data.calibrationBuffer,
        currentSensorValueAverage: null,
        inputEventsCalculated: 0
      }

      broadcastDevicesUpdated()
    })

    socket.on('disconnect', (reason: string) => {
      consola.info(`Disconnected SocketIO from "${socket.handshake.address}", reason: "${reason}"`)
    })
  })

  /* Return function to close server resources. */

  return () => {
    params.deviceDrivers.forEach(dd => dd.close())
  }
}

export default createServer
