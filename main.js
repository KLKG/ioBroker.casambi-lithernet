'use strict';

/*
 * Created with @iobroker/create-adapter v1.26.3
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

// Load your modules here, e.g.:
// const fs = require("fs");

// Load your modules here, e.g.:
const dgram = require("dgram");
const request = require("request");

/**
 * The adapter instance
 * @type {ioBroker.Adapter}
 */
let adapter;

const DEFAULT_UDP_PORT = 10020;
const BROADCAST_UDP_PORT = 10020;

let txSocket;
let rxSocketReports = null;
let rxSocketBroadcast = null;
let sendDelayTimer = null;

const states = {};          // contains all actual state values
const stateChangeListeners = {};
const currentStateValues = {}; // contains all actual state values
const sendQueue = [];

//var ioBroker_Settings
let ioBrokerLanguage      = "en";

/**
 * Starts the adapter instance
 * @param {Partial<utils.AdapterOptions>} [options]
 */
function startAdapter(options) {
    // Create the adapter and define its methods
    return adapter = utils.adapter(Object.assign({}, options, {
        name: 'casambi-lithernet',

        ready: onAdapterReady,

        unload: onAdapterUnload,

        stateChange: onAdapterStateChange,

    }));
}

// startup
function onAdapterReady() {
    if (! checkConfig()) {
        adapter.log.error("start of adapter not possible due to config errors");
        return;
    }

    main();
}

//unloading
function onAdapterUnload(callback) {
    try {
        if (sendDelayTimer) {
            clearInterval(sendDelayTimer);
        }

        if (txSocket) {
            txSocket.close();
        }

        if (rxSocketReports) {
            if (rxSocketBroadcast.active)
                rxSocketReports.close();
        }

        if (rxSocketBroadcast) {
            if (rxSocketBroadcast.active)
                rxSocketBroadcast.close();
        }

    } catch (e) {
        if (adapter.log)
            adapter.log.warn("Error while closing: " + e);
    }

    callback();
}

// is called if a subscribed state changes
function onAdapterStateChange (id, state) {

    if (!id || !state) {
        return;
    }
    adapter.log.silly("stateChange " + id + " " + JSON.stringify(state));

    const oldValue = getStateInternal(id);
    let newValue = state.val;

    if (state.ack) {
        return;
    }
    if (! id.startsWith(adapter.namespace)) {
        // do not care for foreign states
        return;
    }

    if (!Object.prototype.hasOwnProperty.call(stateChangeListeners, id)) {
        adapter.log.error("Unsupported state change: " + id);
        return;
    }

    stateChangeListeners[id](oldValue, newValue);
}


async function main() {

    await adapter.setStateAsync("info.connection", false, true);

    adapter.log.info('config option1: ' + adapter.config.option1);
    adapter.log.info('config option2: ' + adapter.config.option2);

    txSocket = dgram.createSocket("udp4");

    rxSocketReports = dgram.createSocket({ type: "udp4", reuseAddr: true });
    rxSocketReports.on("error", (err) => {
        adapter.log.error("RxSocketReports error: " + err.message + "\n" + err.stack);
        rxSocketReports.close();
    });
    rxSocketReports.on("listening", function () {
        rxSocketReports.setBroadcast(true);
        const address = rxSocketReports.address();
        adapter.log.debug("UDP server listening on " + address.address + ":" + address.port);
    });
    rxSocketReports.on("message", handleLithernetMessage);
    rxSocketReports.bind(DEFAULT_UDP_PORT, "0.0.0.0");

    rxSocketBroadcast = dgram.createSocket({ type: "udp4", reuseAddr: true });
    rxSocketBroadcast.on("error", (err) => {
        adapter.log.error("RxSocketBroadcast error: " + err.message + "\n" + err.stack);
        rxSocketBroadcast.close();
    });
    rxSocketBroadcast.on("listening", function () {
        rxSocketBroadcast.setBroadcast(true);
        rxSocketBroadcast.setMulticastLoopback(true);
        const address = rxSocketBroadcast.address();
        adapter.log.debug("UDP broadcast server listening on " + address.address + ":" + address.port);
    });
    rxSocketBroadcast.on("message", handleLithernetBroadcast);
    rxSocketBroadcast.bind(BROADCAST_UDP_PORT);

    adapter.getForeignObject("system.config", function(err, ioBroker_Settings) {
        if (err) {
            adapter.log.error("Error while fetching system.config: " + err);
            return;
        }

        if (ioBroker_Settings && (ioBroker_Settings.common.language == "de")) {
            ioBrokerLanguage = "de";
        } else {
            ioBrokerLanguage = "en";
        }
    });

    adapter.getStatesOf(function (err, data) {
        if (data) {
            for (let i = 0; i < data.length; i++) {
                if (data[i].native && data[i].native.udpKey) {
                    states[data[i].native.udpKey] = data[i];
                }
            }
        }
        // save all state value into internal store
        adapter.getStates("*", function (err, obj) {
            if (err) {
                adapter.log.error("error reading states: " + err);
            } else {
                if (obj) {
                    for (const i in obj) {
                        if (! Object.prototype.hasOwnProperty.call(obj, i)) continue;
                        if (obj[i] !== null) {
                            if (typeof obj[i] == "object") {
                                //do something
                            } else {
                                adapter.log.error("unexpected state value: " + obj[i]);
                            }
                        }
                    }
                } else {
                    adapter.log.error("not states found");
                }
            }
        });
        start();
    });
}

function start() {
    adapter.subscribeStates("*");

    //sendUdpDatagram("i");   only needed for discovery
}

// check if config data is fine for adapter start
function checkConfig() {
    let everythingFine = true;
    if (adapter.config.host == "0.0.0.0" || adapter.config.host == "127.0.0.1") {
        adapter.log.warn("Can't start adapter for invalid IP address: " + adapter.config.host);
        everythingFine = false;
    }

    return everythingFine;
}

// handle incomming message from wallbox
function handleLithernetMessage(message, remote) {
    adapter.log.debug("UDP datagram from " + remote.address + ":" + remote.port + ": '" + message + "'");
    handleMessage(message, "received");
}

// handle incomming broadcast message from wallbox
function handleLithernetBroadcast(message, remote) {
    adapter.log.debug("UDP broadcast datagram from " + remote.address + ":" + remote.port + ": '" + message + "'");
    handleMessage(message, "broadcast");
}

function handleMessage(message, origin) {
    // Mark that connection is established by incomming data
    adapter.setState("info.connection", true, true);
    let msg = "";
    try {
        msg = message.toString().trim();
        if (msg.length === 0) {
            return;
        }

        if (msg[0] == '"') {
            msg = "{ " + msg + " }";
        }
    } catch (e) {
        adapter.log.warn("Error handling " + origin + " message: " + e + " (" + msg + ")");
        return;
    }

}

function sendUdpDatagram(message, highPriority) {
    if (highPriority) {
        sendQueue.unshift(message);
    } else {
        sendQueue.push(message);
    }
    if (!sendDelayTimer) {
        sendNextQueueDatagram();
        sendDelayTimer = setInterval(sendNextQueueDatagram, 300);
    }
}

function sendNextQueueDatagram() {
    if (sendQueue.length === 0) {
        clearInterval(sendDelayTimer);
        sendDelayTimer = null;
        return;
    }
    const message = sendQueue.shift();
    if (txSocket) {
        try {
            txSocket.send(message, 0, message.length, DEFAULT_UDP_PORT, adapter.config.host, function (err) {
                if (err) {
                    adapter.log.warn("UDP send error for " + adapter.config.host + ":" + DEFAULT_UDP_PORT + ": " + err);
                    return;
                }
                adapter.log.debug("Sent '" + message + "' to " + adapter.config.host + ":" + DEFAULT_UDP_PORT);
            });
        } catch (e) {
            if (adapter.log)
                adapter.log.error("Error sending message '" + message + "': " + e);
        }
    }
}

function getStateInternal(id) {
    if ((id == null) || (typeof id !== "string") || (id.trim().length == 0)) {
        return null;
    }
    let obj = id;
    if (! obj.startsWith(adapter.namespace + "."))
        obj = adapter.namespace + "." + id;
    return currentStateValues[obj];
}

