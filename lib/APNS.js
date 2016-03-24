"use strict";

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol ? "symbol" : typeof obj; };

var Parse = require('parse/node').Parse;
// TODO: apn does not support the new HTTP/2 protocal. It is fine to use it in V1,
// but probably we will replace it in the future.
var apn = require('apn');

/**
 * Create a new connection to the APN service.
 * @constructor
 * @param {Object|Array} args An argument or a list of arguments to config APNS connection
 * @param {String} args.cert The filename of the connection certificate to load from disk
 * @param {String} args.key The filename of the connection key to load from disk
 * @param {String} args.pfx The filename for private key, certificate and CA certs in PFX or PKCS12 format, it will overwrite cert and key
 * @param {String} args.passphrase The passphrase for the connection key, if required
 * @param {String} args.bundleId The bundleId for cert
 * @param {Boolean} args.production Specifies which environment to connect to: Production (if true) or Sandbox
 */
function APNS(args) {
  var _this = this;

  // Since for ios, there maybe multiple cert/key pairs,
  // typePushConfig can be an array.
  var apnsArgsList = [];
  if (Array.isArray(args)) {
    apnsArgsList = apnsArgsList.concat(args);
  } else if ((typeof args === 'undefined' ? 'undefined' : _typeof(args)) === 'object') {
    apnsArgsList.push(args);
  } else {
    throw new Parse.Error(Parse.Error.PUSH_MISCONFIGURED, 'APNS Configuration is invalid');
  }

  this.conns = [];
  var _iteratorNormalCompletion = true;
  var _didIteratorError = false;
  var _iteratorError = undefined;

  try {
    var _loop = function _loop() {
      var apnsArgs = _step.value;

      var conn = new apn.Connection(apnsArgs);
      if (!apnsArgs.bundleId) {
        throw new Parse.Error(Parse.Error.PUSH_MISCONFIGURED, 'BundleId is mssing for %j', apnsArgs);
      }
      conn.bundleId = apnsArgs.bundleId;
      // Set the priority of the conns, prod cert has higher priority
      if (apnsArgs.production) {
        conn.priority = 0;
      } else {
        conn.priority = 1;
      }

      // Set apns client callbacks
      conn.on('connected', function () {
        console.log('APNS Connection %d Connected', conn.index);
      });

      conn.on('transmissionError', function (errCode, notification, apnDevice) {
        handleTransmissionError(_this.conns, errCode, notification, apnDevice);
      });

      conn.on('timeout', function () {
        console.log('APNS Connection %d Timeout', conn.index);
      });

      conn.on('disconnected', function () {
        console.log('APNS Connection %d Disconnected', conn.index);
      });

      conn.on('socketError', function () {
        console.log('APNS Connection %d Socket Error', conn.index);
      });

      conn.on('transmitted', function (notification, device) {
        if (device.callback) {
          device.callback({
            notification: notification,
            transmitted: true,
            device: device
          });
        }
        console.log('APNS Connection %d Notification transmitted to %s', conn.index, device.token.toString('hex'));
      });

      _this.conns.push(conn);
    };

    for (var _iterator = apnsArgsList[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
      _loop();
    }
    // Sort the conn based on priority ascending, high pri first
  } catch (err) {
    _didIteratorError = true;
    _iteratorError = err;
  } finally {
    try {
      if (!_iteratorNormalCompletion && _iterator.return) {
        _iterator.return();
      }
    } finally {
      if (_didIteratorError) {
        throw _iteratorError;
      }
    }
  }

  this.conns.sort(function (s1, s2) {
    return s1.priority - s2.priority;
  });
  // Set index of conns
  for (var index = 0; index < this.conns.length; index++) {
    this.conns[index].index = index;
  }
}

/**
 * Send apns request.
 * @param {Object} data The data we need to send, the format is the same with api request body
 * @param {Array} devices A array of devices
 * @returns {Object} A promise which is resolved immediately
 */
APNS.prototype.send = function (data, devices) {
  var _this2 = this;

  var coreData = data.data;
  var expirationTime = data['expiration_time'];
  var notification = generateNotification(coreData, expirationTime);

  var promises = devices.map(function (device) {
    var qualifiedConnIndexs = chooseConns(_this2.conns, device);
    // We can not find a valid conn, just ignore this device
    if (qualifiedConnIndexs.length == 0) {
      return Promise.resolve({
        transmitted: false,
        result: { error: 'No connection available' }
      });
    }
    var conn = _this2.conns[qualifiedConnIndexs[0]];
    var apnDevice = new apn.Device(device.deviceToken);
    apnDevice.connIndex = qualifiedConnIndexs[0];
    // Add additional appIdentifier info to apn device instance
    if (device.appIdentifier) {
      apnDevice.appIdentifier = device.appIdentifier;
    }
    return new Promise(function (resolve, reject) {
      apnDevice.callback = resolve;
      conn.pushNotification(notification, apnDevice);
    });
  });
  return Parse.Promise.when(promises);
};

function handleTransmissionError(conns, errCode, notification, apnDevice) {
  // This means the error notification is not in the cache anymore or the recepient is missing,
  // we just ignore this case
  if (!notification || !apnDevice) {
    return;
  }

  // If currentConn can not send the push notification, we try to use the next available conn.
  // Since conns is sorted by priority, the next conn means the next low pri conn.
  // If there is no conn available, we give up on sending the notification to that device.
  var qualifiedConnIndexs = chooseConns(conns, apnDevice);
  var currentConnIndex = apnDevice.connIndex;

  var newConnIndex = -1;
  // Find the next element of currentConnIndex in qualifiedConnIndexs
  for (var index = 0; index < qualifiedConnIndexs.length - 1; index++) {
    if (qualifiedConnIndexs[index] === currentConnIndex) {
      newConnIndex = qualifiedConnIndexs[index + 1];
      break;
    }
  }
  // There is no more available conns, we give up in this case
  if (newConnIndex < 0 || newConnIndex >= conns.length) {
    if (apnDevice.callback) {
      apnDevice.callback({
        response: { error: 'APNS can not find vaild connection for ' + apnDevice.token, code: errCode },
        status: errCode,
        transmitted: false
      });
    }
    return;
  }

  var newConn = conns[newConnIndex];
  // Update device conn info
  apnDevice.connIndex = newConnIndex;
  // Use the new conn to send the notification
  newConn.pushNotification(notification, apnDevice);
}

function chooseConns(conns, device) {
  // If device does not have appIdentifier, all conns maybe proper connections.
  // Otherwise we try to match the appIdentifier with bundleId
  var qualifiedConns = [];
  for (var index = 0; index < conns.length; index++) {
    var _conn = conns[index];
    // If the device we need to send to does not have
    // appIdentifier, any conn could be a qualified connection
    if (!device.appIdentifier || device.appIdentifier === '') {
      qualifiedConns.push(index);
      continue;
    }
    if (device.appIdentifier === _conn.bundleId) {
      qualifiedConns.push(index);
    }
  }
  return qualifiedConns;
}

/**
 * Generate the apns notification from the data we get from api request.
 * @param {Object} coreData The data field under api request body
 * @returns {Object} A apns notification
 */
function generateNotification(coreData, expirationTime) {
  var notification = new apn.notification();
  var payload = {};
  for (var key in coreData) {
    switch (key) {
      case 'alert':
        notification.setAlertText(coreData.alert);
        break;
      case 'badge':
        notification.badge = coreData.badge;
        break;
      case 'sound':
        notification.sound = coreData.sound;
        break;
      case 'content-available':
        notification.setNewsstandAvailable(true);
        var isAvailable = coreData['content-available'] === 1;
        notification.setContentAvailable(isAvailable);
        break;
      case 'category':
        notification.category = coreData.category;
        break;
      default:
        payload[key] = coreData[key];
        break;
    }
  }
  notification.payload = payload;
  notification.expiry = expirationTime;
  return notification;
}

if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
  APNS.generateNotification = generateNotification;
  APNS.chooseConns = chooseConns;
  APNS.handleTransmissionError = handleTransmissionError;
}
module.exports = APNS;