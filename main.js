/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';


// you have to require the utils module and call adapter function
const utils = require('@iobroker/adapter-core'); // Get common adapter utils
const adapter = new utils.Adapter('mihome-vacuum');
const dgram = require('dgram');
const MiHome = require(__dirname + '/lib/mihomepacket');
const TimerManager = require(__dirname + '/lib/timerManager');
const RoomManager = require(__dirname + '/lib/roomManager');
global.systemDictionary = {}
require(__dirname + '/admin/words.js')

let maphelper = require(__dirname + '/lib/maphelper')


const server = dgram.createSocket('udp4');

let userLang = "en"
let lastResponse = 0;
let messages = {};
let connected = false;
let pingTimeout = null;
let pingInterval = 0;           // will be overwrite in sendPing()
let maxResponseTime = 60000;    // max Time difference for reconnecting
let nextWiFiCheck = 0;          // will be set in checkWiFi()
let packet;
let cleanLog = [];
let cleanLogHtmlAllLines = '';
let clean_log_html_table = '';
let logEntries = {};
let roomManager = null;
let timerManager = null;
let Map

// this parts will be translated
const i18n = {
    weekDaysFull: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    notAvailable: "not available",
    nextTimer: "next timer",
    loadRooms: "load rooms from robot",
    cleanRoom: "clean Room",
    cleanMultiRooms: "clean assigned rooms",
    addRoom: "insert map Index or zone coordinates",
    waterBox_installed: "water box installed",
    waterBox_filter: "clean water Filter",
    waterBox_filter_reset: "water filter reset",
    waitingPos: "waiting position"
}
const cleanStates = {
    Unknown : 0,
	Initiating : 1,
//??? : 4,
	Cleaning : 3,
	Back_toHome : 6,
	ManuellMode : 7,
	Charging : 5,
	Charging_Error : 9,
	Pause : 2,
	SpotCleaning : 11,
	InError : 12,
	ShuttingDown : 13,
	Updating : 14,
	Docking : 15,
	GoingToSpot : 16,
	ZoneCleaning : 17,
	RoomCleaning : 18
}
const activeCleanStates = {
    3: { 
        name: 'all ',
        resume: 'app_start'
    },
    11: { 
        name: 'spot ',
        resume: 'app_spot'
    },    
    17: {
        name:'zone ', 
        resume:'resume_zoned_clean'
    },
    18: {
        name:'segment ', 
        resume:'resume_segment_clean'
    }
}

const MAP = function () {}; // init MAP

class Cleaning {
    constructor(){
        this.state = cleanStates.Unknown // current robot Status
        this.activeState = 0 // if robot is working, than here the status is saved
        this.activeChannels= null;
        this.queue = [] // if new job is aclled, while robot is already cleaning
    }

    /**
     * is called, if robot send status
     * @param {number} newVal new status
     */
    setRemoteState(newVal) {
        this.state = newVal;
        adapter.setState('info.state', this.state, true);

        if (activeCleanStates[this.state]) {
            if (newVal == this.activeState){ // activeState was set in startCleaning and now confirmed
                if (this.activeChannels){
                    for (let i in this.activeChannels)
                        adapter.setState(this.activeChannels[i] + '.state', i18n.cleanRoom, true);
                }
            } else
                this.activeState = this.state;
            sendCommand(com.get_sound_volume)
            if (features.carpetMode)
                setTimeout(sendCommand, 200, com.get_carpet_mode)
        } else if (cleanStates.Pause === this.state) {
            // activeState should be the initial State, so do nothing
            return
        } else {
            this.activeState = 0
            if (this.activeChannels){
                for (let i in this.activeChannels)
                    adapter.setState(this.activeChannels[i] + '.state', '', true);
                this.activeChannels= null
            }
            if ([cleanStates.Sleeping, cleanStates.Waiting, cleanStates.Back_toHome, cleanStates.Charging, cleanStates.GoingToSpot].indexOf(this.state) > -1) {
                if (this.queue.length > 0) {
                    adapter.log.debug("use clean trigger from Queue")
                    adapter.emit('message', this.queue.shift());
                    this.updateQueue()
                }
            }
            if (cleanStates.Charging === newVal){
                sendCommand(com.get_consumable).finally(function(){
                    sendCommand(com.clean_summary)
                })
                MAP.ENABLED && setTimeout(sendCommand,2000, com.loadMap);
            }
        }
        adapter.setState('control.clean_home', this.activeState != 0, true);
 
        if (MAP.ENABLED) { // set map getter to true if..
            if ([cleanStates.Cleaning, cleanStates.Back_toHome, cleanStates.SpotCleaning, cleanStates.GoingToSpot, cleanStates.ZoneCleaning, cleanStates.RoomCleaning].indexOf(this.state) > -1) {
                MAP.StartMapPoll();
            } else {
                MAP.GETMAP = false;
            }
        }
    }

    startCleaning(cleanStatus, messageObj){
        let activeCleanState= activeCleanStates[cleanStatus]
        if (!activeCleanState)
            return !!adapter.log.warn("Invalid cleanStatus(" + cleanStatus + ") for startCleaning")
        setTimeout(sendPing, 3000);
        if (this.activeState){
            if (cleanStatus === cleanStates.Cleaning && adapter.config.enableResumeZone) {
                adapter.log.debug('Resuming paused ' + activeCleanStates[this.activeState].name);
                sendCommand({method:activeCleanStates[this.activeState].resume}).then(function(){
                    sendCommand(com.get_status, ['run_state','mode','err_state','battary_life','box_type','mop_type','s_time','s_area','suction_grade','water_grade','remember_map','has_map','is_mop','has_newmap'])
                })
            } else {
                adapter.log.info("should trigger cleaning " + activeCleanState.name + (messageObj.message || '') + ", but is currently active. Add to queue")
                messageObj.info= activeCleanState.name;
                this.push(messageObj)
            }
            return false;
        } else {
            this.activeState = cleanStatus;
            this.activeChannels= messageObj.channels;
            if (this.activeChannels && this.activeChannels.length == 1) {
                adapter.getState(this.activeChannels[0] + '.roomFanPower', function (err, fanPower) {
                    adapter.setState("control.fan_power", fanPower.val);
                })
            }            
            adapter.log.info("trigger cleaning " + activeCleanState.name + (messageObj.message || ''))
            return true
        }
    }

    stopCleaning(){
        sendCommand(com.pause, [0,2,0]).then(()=>{
            sendCommand(com.home,[1]).then(sendPing)
        });
        this.clearQueue();
    }

    clearQueue(){
        for (let i in this.queue){
            let channels= this.queue[i].channels
            if (channels)
                for (let c in channels)
                    adapter.setState(channels[c] + '.state', '', true);
        }
        this.queue= []
        this.updateQueue()
    }

    push(messageObj) {
        this.queue.push(messageObj)
        if (messageObj.channels){
            let getObjs= []
            for (let i in messageObj.channels){
                getObjs.push(adapter.getObjectAsync(messageObj.channels[i])
                                        .then((obj) => { messageObj.info += ' ' + obj.common.name }));
            }
            Promise.all(getObjs).then(() => {this.updateQueue()})
        } else
            this.updateQueue()
    }

    updateQueue(){
        pingInterval = this.queue.length > 0 ? 10000 : adapter.config.pingInterval;
        let json= []
        for (let i= this.queue.length - 1; i >=0; i--){
            json.push(this.queue[i].info)
            let channels= this.queue[i].channels
            if (channels)
                for (let c in channels)
                    adapter.setState(channels[c] + '.state', i18n.waitingPos + ': ' + i , true);
        }
        adapter.setStateChanged('info.queue', JSON.stringify(json), true)
    }
}

const cleaning = new Cleaning()

// new features are initial false and shold be enabled, if result from robot is available
class FeatureManager {

    constructor() {
        this.firmware = null
        this.model = null
        this.goto = false
        this.zoneClean = false
        this.mob = false
        this.water_box = null
        this.carpetMode = null
        this.roomMapping = null
    }

    init() {
        //adapter.states
        adapter.getState('info.device_model', function (err, state) {
            state && state.val && features.setModel(state.val);
        });
        adapter.getState('info.device_fw', function (err, state) {
            state && state.val && features.setFirmware(state.val);
        });

        // we get miIO.info only, if the robot is connected to the internet, so we init with unavailable
        adapter.setState('info.wifi_signal', "unavailable", true);

        roomManager = new RoomManager(adapter, i18n)
        timerManager = new TimerManager(adapter, i18n)

    }

    detect() {
        sendCommand(com.get_carpet_mode) // test, if supported
        sendCommand(com.loadRooms); // test, if supported
    }

    setModel(model) {
        if (this.model != model) {
            adapter.setStateChanged('info.device_model', model, true);
            this.model = model;
            this.mob = (model === 'roborock.vacuum.s5' || model === 'roborock.vacuum.s6')

            if (model === 'roborock.vacuum.m1s' || model === 'roborock.vacuum.s5' || model === 'roborock.vacuum.s6') {
                adapter.log.info('change states from State control.fan_power');
                adapter.setObject('control.fan_power', {
                    type: 'state',
                    common: {
                        name: 'Suction power',
                        type: 'number',
                        role: 'level',
                        read: true,
                        write: true,
                        min: 101,
                        max: 106,
                        states: {
                            101: 'QUIET',
                            102: 'BALANCED',
                            103: 'TURBO',
                            104: 'MAXIMUM',
                            106: 'CUSTOM' // setting for rooms will be used
                        }
                    },
                    native: {}
                });
            }
            if (this.mob) {
                adapter.log.info('extend state mop for State control.fan_power');
                setTimeout(adapter.extendObject, 2000, 'control.fan_power', {
                    common: {
                        max: 105,
                        states: {
                            105: "MOP" // no vacuum, only mop
                        }
                    }
                }); // need time, until the new setting above
            }
        }
    }

    setFirmware(fw_ver) {
        if (this.firmware != fw_ver) {
            this.firmware = fw_ver
            adapter.setStateChanged('info.device_fw', fw_ver, true);

            let fw = fw_ver.split('_'); // Splitting the FW into [Version, Build] array.
            if (parseInt(fw[0].replace(/\./g, ''), 10) > 339 || (parseInt(fw[0].replace(/\./g, ''), 10) === 339 && parseInt(fw[1], 10) >= 3194)) {
                adapter.log.info('New generation or new fw(' + fw + ') detected, create new states goto and zoneclean');
                this.goto = true;
                this.zoneClean = true;
            }
            this.goto && adapter.setObjectNotExists('control.goTo', {
                type: 'state',
                common: {
                    name: 'Go to point',
                    type: 'string',
                    read: true,
                    write: true,
                    desc: 'let the vacuum go to a point on the map',
                },
                native: {}
            });
            if (this.zoneClean) {
                adapter.setObjectNotExists('control.zoneClean', {
                    type: 'state',
                    common: {
                        name: 'Clean a zone',
                        type: 'string',
                        read: true,
                        write: true,
                        desc: 'let the vacuum go to a point and clean a zone',
                    },
                    native: {}
                });
                if (!adapter.config.enableResumeZone) {
                    adapter.setObjectNotExists('control.resumeZoneClean', {
                        type: 'state',
                        common: {
                            name: "Resume paused zoneClean",
                            type: "boolean",
                            role: "button",
                            read: false,
                            write: true,
                            desc: "resume zoneClean that has been paused before",
                        },
                        native: {}
                    });
                    adapter.setObjectNotExists('control.resumeRoomClean', {
                        type: 'state',
                        common: {
                            name: "Resume paused roomClean",
                            type: "boolean",
                            role: "button",
                            read: false,
                            write: true,
                            desc: "resume roomClean that has been paused before",
                        },
                        native: {}
                    });                    
                } else {
                    adapter.deleteState(adapter.namespace, 'control', 'resumeZoneClean');
                    adapter.deleteState(adapter.namespace, 'control', 'resumeRoomClean');
                }
            }
        }
    }

    setCarpetMode(enabled) {
        if (this.carpetMode === null) {
            this.carpetMode = true
            adapter.log.info('create state for carpet_mode');
            adapter.setObjectNotExists('control.carpet_mode', {
                type: 'state',
                common: {
                    name: 'Carpet mode',
                    type: 'boolean',
                    role: 'switch',
                    read: true,
                    write: true,
                    desc: 'Fanspeed is Max on carpets',
                },
                native: {}
            });
        }
        adapter.setStateChanged('control.carpet_mode', enabled === 1, true);
    }

    setWaterBox(water_box_status) {
        if (this.water_box === null) { // todo: check if filter_element_work_time depends on water_box_status and 
            this.water_box = !isNaN(water_box_status);
            if (this.water_box) {
                adapter.log.info('create states for water box');
                adapter.setObjectNotExists('info.water_box', {
                    type: "state",
                    common: {
                        name: i18n.waterBox_installed,
                        type: "text",
                        role: "info",
                        read: true,
                        write: false
                    },
                    native: {}
                });
                adapter.log.info('create states for water box filter');
                adapter.setObjectNotExists('consumable.water_filter', {
                    type: "state",
                    common: {
                        name: i18n.waterBox_filter,
                        type: "number",
                        role: "level",
                        read: true,
                        write: false,
                        unit: "%"
                    },
                    native: {}
                });
                adapter.setObjectNotExists('consumable.water_filter_reset', {
                    type: "state",
                    common: {
                        name: i18n.waterBox_filter_reset,
                        type: "boolean",
                        role: "button",
                        read: false,
                        write: true,
                        unit: "%"
                    },
                    native: {}
                });
            }
        }
        this.water_box && adapter.setStateChanged('info.water_box', water_box_status === 1, true);
    }
}
const features = new FeatureManager();

//Tabelleneigenschaften
// TODO: Translate
const clean_log_html_attr = '<colgroup> <col width="50"> <col width="50"> <col width="80"> <col width="100"> <col width="50"> <col width="50"> </colgroup>';
const clean_log_html_head = '<tr> <th>Datum</th> <th>Start</th> <th>Saugzeit</th> <th>Fläche</th> <th>???</th> <th>Ende</th></tr>';


// is called if a subscribed state changes
adapter.on('stateChange', function (id, state) {
    if (!state || state.ack) return;

    // Warning, state can be null if it was deleted
    adapter.log.debug('stateChange ' + id + ' ' + JSON.stringify(state));

    // output to parser

    const terms = id.split('.')
    const command = terms.pop();
    const parent = terms.pop();

         // Send own commands
        if (command === 'X_send_command') {
            const values = (state.val || '').trim().split(';');
            //const method = values[0];
            let params = [''];
            if (values[1]) {
                try {
                    params = JSON.parse(values[1]);
                } catch (e) {
                    return adapter.setState('control.X_get_response', 'Could not send these params because its not in JSON format: ' + values[1] , true);
                }
                adapter.log.info('send message: Method: ' + values[0] + ' Params: ' + values[1]);
            } else {           
                adapter.log.info('send message: Method: ' + values[0]);
            }
            callRobot(values[0], params).then(answer => {
                adapter.setState(id, state.val, true);
                adapter.setState('control.X_get_response', JSON.stringify(answer.result), true);
            }).catch(err => {
                adapter.setState('control.X_get_response', err.message, true);
            });

        } else if (command === 'clean_home' || command === 'start') {
            if (state.val) {
                adapter.sendTo(adapter.namespace, "startVacuuming",null)
            } else if (command === 'clean_home' && cleaning.activeState) {
                cleaning.stopCleaning()
            }
            adapter.setForeignState(id, state.val, true);

        } else if (command === 'home') {
            if (!state.val) return;
            cleaning.stopCleaning()
            adapter.setForeignState(id, true, true);

        } else if (command === 'clearQueue') {
            if (!state.val) return;
            cleaning.clearQueue()
            adapter.setForeignState(id, true, true);

        } else if (command === 'spotclean') {
            if (!state.val) return;
            adapter.sendTo(adapter.namespace, "cleanSpot",null)
            adapter.setForeignState(id, state.val, true);

        } else if (command === 'carpet_mode') {
            //when carpetmode change
            sendCommand({method:'set_carpet_mode'}, [{
                enable: state.val === true || state.val === 'true' ? 1 : 0
            }]).then(function () {
                adapter.setForeignState(id, state.val, true);
                sendCommand(com.get_carpet_mode)
            });

        } else if (command === 'goTo') {
            //changeMowerCfg(id, state.val);
            //goto function wit error catch
            parseGoTo(state.val, function () {
                adapter.setForeignState(id, state.val, true);
            });

        } else if (command === 'zoneClean') {
            adapter.sendTo(adapter.namespace, "cleanZone", state.val)
            adapter.setForeignState(id, '', true);
/* removed to commands.js
        } else if (command === 'resumeZoneClean') {
            if (!state.val) return;
            sendMsg('resume_zoned_clean', null, function () {
                adapter.setForeignState(id, state.val, true);
            });

        } else if (command === 'resumeRoomClean') {
            if (!state.val) return;
            sendMsg('resume_segment_clean', null, function () {
                adapter.setForeignState(id, state.val, true);
            });

        } else if (command === 'loadRooms') {
            if (!state.val) return;
            sendMsg('get_room_mapping', null, function () {
                adapter.setForeignState(id, state.val, true);
            });
*/            
        } else if (command === 'addRoom') {
            if (!isNaN(state.val))
                roomManager.createRoom("manual_" + state.val, parseInt(state.val, 10))
            else {
                let terms = state.val.match(/((?:[0-9]+\,){3,3}[0-9]+)(\,[0-9]+)?/)
                if (terms)
                    roomManager.createRoom("manual_" + terms[1].replace(/,/g, '_'), '[' + terms[1] + (terms[2] || ',1') + ']')
                else
                    adapter.log.warn('invalid input for addRoom, use index of map or coordinates like 1111,2222,3333,4444')
            }
            adapter.setForeignState(id, '', true);

        } else if (command === 'roomClean') {
            if (!state.val) return;
            roomManager.cleanRooms([id.replace("roomClean", "mapIndex")]);
            adapter.setForeignState(id, true, true);
        } else if (command === 'multiRoomClean' || parent === 'timer') {
            if (parent === 'timer') {
                adapter.setForeignState(id, (state.val == TimerManager.SKIP || state.val == TimerManager.DISABLED) ? state.val : TimerManager.ENABLED, true, function () {
                    timerManager.calcNextProcess()
                });
                if (state.val != TimerManager.START) return
            } else {
                if (!state.val) return;
                adapter.setForeignState(id, true, true);
            }
            roomManager.cleanRoomsFromState(id);
            
        } else if (command === 'roomFanPower') {
            // do nothing, only set fan power for next roomClean
            adapter.setForeignState(id, state.val, true);
        } else if (com[command]) {
            let params = com[command].params || '';
            if (state.val !== true && state.val !== 'true') {
                params = state.val;
            }
            if (state.val !== false && state.val !== 'false') {
                sendCommand(com[command], [params]).then(function () {
                    adapter.setForeignState(id, state.val, true);
                });
            }
        } else {
            adapter.log.error('Unknown state "' + id + '"');
        }
    

});

adapter.on('unload', function (callback) {
    if (pingTimeout) clearTimeout(pingTimeout);
    adapter.setState('info.connection', false, true);
    if (typeof callback === 'function') callback();
});

adapter.on('ready', main);

const com = {
    "find": {
        "method": "find_me"
    },
     "start": {
		"method": "set_mode_withroom",
		"params": [0,1,0]
    },
    "pause": {
        "method": "set_mode_withroom",
		"params": [0,2,0]
    },
    "home": {
        "method": "set_charge",
		"params": [1]
    },
    "get_status": {
        "method": "get_prop",
		"params": ['run_state','mode','err_state','battary_life','box_type','mop_type','s_time','s_area','suction_grade','water_grade','remember_map','has_map','is_mop','has_newmap'],
        "action": function (answer) {
            const status = parseStatus(answer);
            adapter.setStateChanged('info.battery', status.battery, true);
            adapter.setStateChanged('info.cleanedtime', Math.round(status.clean_time / 60), true);
            adapter.setStateChanged('info.cleanedarea', Math.round(status.clean_area / 10000) / 100, true);
            adapter.setStateChanged('control.fan_power', Math.round(status.fan_power), true);
            adapter.setStateChanged('info.error', status.error_code, true);
            adapter.setStateChanged('info.dnd', status.dnd_enabled, true);
            features.setWaterBox(status.water_box_status);
            if (cleaning.state != status.state) {
                cleaning.setRemoteState(status.state)
            }
        }
    },
    "get_consumable": {
        "method": "get_consumables",
        "action": function (answer) {
            // response= {"result":[{"main_brush_work_time":11472,"side_brush_work_time":11472,"filter_work_time":11472,"filter_element_work_time":3223,"sensor_dirty_time":11253}]}
            const consumable = answer.result[0] //parseConsumable(answer)
            adapter.setStateChanged('consumable.main_brush', 100 - (Math.round(consumable.main_brush_work_time / 3600 / 3)), true);    // 300h
            adapter.setStateChanged('consumable.side_brush', 100 - (Math.round(consumable.side_brush_work_time / 3600 / 2)), true);    // 200h
            adapter.setStateChanged('consumable.filter', 100 - (Math.round(consumable.filter_work_time / 3600 / 1.5)), true);          // 150h
            adapter.setStateChanged('consumable.sensors', 100 - (Math.round(consumable.sensor_dirty_time / 3600 / 0.3)), true);        // 30h
            features.water_box && adapter.setStateChanged('consumable.water_filter', 100 - (Math.round(consumable.filter_element_work_time / 3600)), true);          // 100h
        }
    },
    "get_carpet_mode": {
        "method": "get_carpet_mode",
        "action": function (answer) {
            //"result":[{"enable":1,"current_integral":450,"current_high":500,"current_low":400,"stall_time":10}]
            features.setCarpetMode(answer.result[0].enable)
        }
    },
    "get_sound_volume": {
        "method": "get_sound_volume"
    },
    "sound_volume": {
        "method": "change_sound_volume",
        "action": function (answer) {
            adapter.setStateChanged('control.sound_volume', answer.result[0], true);
        }
    },
    "sound_volume_test": {
        "method": "test_sound_volume"
    },
    "set_language": {
        "method": "set_language",
		"params": [2]
    },
    "fan_power": {
        "method": "set_custom_mode"
    },
    "clean_summary": {
        "method": "get_clean_summary",
        "action": function (answer) {
            const summary = parseCleaningSummary(answer);
            adapter.setStateChanged('history.total_time', Math.round(summary.clean_time / 60), true);
            adapter.setStateChanged('history.total_area', Math.round(summary.total_area / 1000000), true);
            adapter.setStateChanged('history.total_cleanups', summary.num_cleanups, true);
            if (!isEquivalent(summary.cleaning_record_ids, logEntries)) {
                logEntries = summary.cleaning_record_ids;
                cleanLog = [];
                cleanLogHtmlAllLines = '';
                getHistoryLog(() => {
                    adapter.setState('history.allTableJSON', JSON.stringify(cleanLog), true);
                    adapter.log.debug('CLEAN_LOGGING' + JSON.stringify(cleanLog));
                    adapter.setState('history.allTableHTML', clean_log_html_table, true);
                });
            }
            //adapter.log.info('log_entrya' + JSON.stringify(summary.cleaning_record_ids));
            //adapter.log.info('log_entry old' + JSON.stringify(logEntries));  
        }
    },
    "miIO_info": {
        "method": "miIO.info",
        "action": function (answer) {
            /*  response= {"result":{"hw_ver":"Linux","fw_ver":"3.5.4_0850",
            "ap":{"ssid":"xxxxx","bssid":"xx:xx:xx:xx:xx:xx","rssi":-46},
            "netif":{"localIp":"192.168.1.154","mask":"255.255.255.0","gw":"192.168.1.1"},
            "model":"roborock.vacuum.s6","mac":"yy:yy:yy:yy:yy:yy","token":"xxxxxxxxxxxxxxxxxxxxxxxxx","life":59871} */
            const info = answer.result
            features.setFirmware(info.fw_ver)
            features.setModel(info.model)
            adapter.setStateChanged('info.wifi_signal', info.ap.rssi, true);
        }
    },
    "clean_record": {
        "method": "get_clean_record",
        "action": function (answer) {
            const records = parseCleaningRecords(answer);
            for (let j = 0; j < records.length; j++) {
                const record = records[j];

                const dates = new Date();
                let hour = '';
                let min = '';
                dates.setTime(record.start_time * 1000);
                if (dates.getHours() < 10) {
                    hour = '0' + dates.getHours();
                } else {
                    hour = dates.getHours();
                }
                if (dates.getMinutes() < 10) {
                    min = '0' + dates.getMinutes();
                } else {
                    min = dates.getMinutes();
                }

                const log_data = {
                    Datum: dates.getDate() + '.' + (dates.getMonth() + 1),
                    Start: hour + ':' + min,
                    Saugzeit: Math.round(record.duration / 60) + ' min',
                    'Fläche': Math.round(record.area / 10000) / 100 + ' m²',
                    Error: record.errors,
                    Ende: record.completed
                };


                cleanLog.push(log_data);
                clean_log_html_table = makeTable(log_data);


            }
        }
    },
    "filter_reset": {
        "method": "reset_consumable",
        "params": "filter_work_time"
    },
    "water_filter_reset": {
        "method": "reset_consumable",
        "params": "filter_element_work_time"
    },
    "sensors_reset": {
        "method": "reset_consumable",
        "params": "sensor_dirty_time"
    },
    "main_brush_reset": {
        "method": "reset_consumable",
        "params": "main_brush_work_time"
    },
    "side_brush_reset": {
        "method": "reset_consumable",
        "params": "side_brush_work_time"
    },
    "spotclean": {
        "method": "app_spot"
    },
    "resumeZoneClean": {
        "method": "resume_zoned_clean"
    },
    "resumeRoomClean": {
        "method": "resume_segment_clean"
    },
    "loadRooms": {
        "method": "get_room_mapping",
        "action": function (answer) {
            features.roomMapping = true;
            if (answer.result.length) {
                roomManager.processRoomMaping(answer);
            } else if (!answer.result.length) {
                adapter.log.debug('Empty array try to get from Map')
                MAP.getRoomsFromMap(answer);
            }
        }
    },
    "loadMap": { // todo: when is trigered get_fresh_map_v1??
        "method": "get_map_v1",
        "action": function (answer) {
            MAP.updateMapPointer(answer.result[0]);
        }
    }

}
com.filter_reset.action= 
com.water_filter_reset.action= 
com.sensors_reset.action= 
com.main_brush_reset.action= 
com.side_brush_reset.action= function(answer){
    sendCommand(com.get_consumable)
}

// function to control goto params
function parseGoTo(params, callback) {
    const coordinates = params.split(',');
    if (coordinates.length === 2) {
        const xVal = coordinates[0];
        const yVal = coordinates[1];

        if (!isNaN(yVal) && !isNaN(xVal)) {
            //send goTo request with coordinates
            sendCommand({method:'app_goto_target', action:callback}, [parseInt(xVal), parseInt(yVal)])
        } else 
            adapter.log.error('GoTo need two coordinates with type number');
        adapter.log.info('xVAL: ' + xVal + '  yVal:  ' + yVal);

    } else {
        adapter.log.error('GoTo only work with two arguments seperated by ', '');
    }
}
/**
 * send a command to the robot and returns a Promise, which need no catch 
 * if you want to react on error, use callRobot directly
 * @param {*} comObj object, see com definition
 * @param {*} params params for the command
 */
function sendCommand(comObj, params){
    return new Promise(async function (resolve, reject) {
        callRobot(comObj.method, params).then(answer => {
            if (typeof comObj.action === "function")
                comObj.action(answer)
            resolve(answer)
        }, err => {
            adapter.log.debug("sendCommand: " + err.message)
        })
    })
}
/**
 * calls the robot with method and params and return a Promise
 * @param {*} method 
 * @param {*} params 
 */
function callRobot(method, params){
    return new Promise(async function (resolve, reject) {
        if (method) {
            const message = {};
            message.id = packet.msgCounter++;
            message.method = method;
			
            if (!(params === '' || params === undefined || params === null || (params instanceof Array && params.length === 1 && params[0] === ''))) {
                message.params = params;
            }
            messages[message.id] = {
              str: JSON.stringify(message).replace('["[', '[[').replace(']"]', ']]').replace('[[','[').replace(']]',']'),
                reject: reject,
                resolve: resolve,
                tryCount: 0
            };
            await sendMsgToRobot(message.id)
        } else {
            reject({message:'Could not build message without arguments'});
        }
    })
}

async function sendMsgToRobot(msgCounter){
    let message = messages[msgCounter]
    if (!message)
        return;
    if (message.tryCount > 2){
        delete messages[msgCounter]
        adapter.log.debug('no answer for ' + message.str + '(id:' + msgCounter +') received, giving up')
        if (typeof message.reject === 'function')  
            message.reject({message: 'no answer received after after ' + message.tryCount + ' times'});    
        return 
    }
    try {
        message.tryCount++;
        const cmdraw = packet.getRaw_fast(message.str);
        server.send(cmdraw, 0, cmdraw.length, adapter.config.port, adapter.config.ip, err => {
            if (err) adapter.log.error('Cannot send command: ' + err);
        });
        adapter.log.debug('sendMsg[' + message.tryCount + '] >>> ' + message.str);
        //adapter.log.silly('sendMsgRaw >>> ' + cmdraw.toString('hex'));
        setTimeout(sendMsgToRobot,10000,msgCounter) // check in 10 sec, if robo send answer
    } catch (err) {
        adapter.log.warn('Cannot send message: ' + err);
        if (typeof message.reject === 'function')  
            message.reject({message: err}); 
    }
}

function receiveMsgFromRobot(message) {
    //Search id in answer
    let requestMessage
    try {
        const answer = JSON.parse(message);
        answer.id = parseInt(answer.id, 10);
        lastResponse= new Date();
        requestMessage = messages[answer.id] 
        requestMessage && delete messages[answer.id];
        if (answer.error) {
            if (requestMessage && typeof requestMessage.reject === 'function')  
                requestMessage.reject(answer.error); 
            return adapter.log.error("[" + answer.id + "](" + (requestMessage ? requestMessage.str : 'unknown request message') + ") -> " + answer.error.message)
        }
        if (!requestMessage){
            throw 'could not found request message for id ' + answer.id
        }
        if (typeof requestMessage.resolve === 'function') 
            requestMessage.resolve(answer);
    } catch (err) {
        adapter.log.debug('The answer from the robot is not correct! (' + err + ') ' + JSON.stringify(message));
        if (requestMessage && typeof requestMessage.reject === 'function') 
            requestMessage.reject({message:'The answer from the robot is not correct! (' + err + ') '});
    }
}


function str2hex(str) {
    str = str.replace(/\s/g, '');
    const buf = Buffer.alloc(str.length / 2);

    for (let i = 0; i < str.length / 2; i++) {
        buf[i] = parseInt(str[i * 2] + str[i * 2 + 1], 16);
    }
    return buf;
}

/** Parses the answer to a get_clean_summary message */
function parseCleaningSummary(response) {
    response = response.result;
    return {
        clean_time: response[0], // in seconds
        total_area: response[1], // in cm^2
        num_cleanups: response[2],
        cleaning_record_ids: response[3], // number[]
    };
}

/** Parses the answer to a get_clean_record message */
function parseCleaningRecords(response) {
    return response.result.map(entry => {
        return {
            start_time: entry[0], // unix timestamp
            end_time: entry[1], // unix timestamp
            duration: entry[2], // in seconds
            area: entry[3], // in cm^2
            errors: entry[4], // ?
            completed: entry[5] === 1, // boolean
        };
    });
}


// TODO: deduplicate from io-package.json
const errorTexts = {
    '0': 'No error',
    '1': 'Laser distance sensor error',
    '2': 'Collision sensor error',
    '3': 'Wheels on top of void, move robot',
    '4': 'Clean hovering sensors, move robot',
    '5': 'Clean main brush',
    '6': 'Clean side brush',
    '7': 'Main wheel stuck?',
    '8': 'Device stuck, clean area',
    '9': 'Dust collector missing',
    '10': 'Clean filter',
    '11': 'Stuck in magnetic barrier',
    '12': 'Low battery',
    '13': 'Charging fault',
    '14': 'Battery fault',
    '15': 'Wall sensors dirty, wipe them',
    '16': 'Place me on flat surface',
    '17': 'Side brushes problem, reboot me',
    '18': 'Suction fan problem',
    '19': 'Unpowered charging station',
};

/** Parses the answer to a get_status message 
 * response =  {"result":[{"msg_ver":2,"msg_seq":5680,"state":8,"battery":100,"clean_time":8,"clean_area":0,
 *                          "error_code":0,"map_present":1,"in_cleaning":0,"in_returning":0,"in_fresh_state":1,
 *                          "lab_status":1,"water_box_status":0,"fan_power":103,"dnd_enabled":0,"map_status":3,"lock_status":0}]
 */
function parseStatus(response) {
    response = response.result[0];
    response.dnd_enabled = response.dnd_enabled === 1;
    response.error_text = errorTexts[response.error_code];
    response.in_cleaning = response.in_cleaning === 1;
    response.map_present = response.map_present === 1;
    //response.state_text= statusTexts[response.state];
    return response;
}

/** Parses the answer to a get_dnd_timer message */
/* function parseDNDTimer(response) {
    response = response.result[0];
    response.enabled = (response.enabled === 1);
    return response;
}*/

function getHistoryLog(callback, i) {
    i = i || 0;

    if (!logEntries || i >= logEntries.length) {
        callback && callback();
    } else {
        if (logEntries[i] !== null || logEntries[i] !== 'null') {
            //adapter.log.debug('Request log entry: ' + logEntries[i]);
            sendCommand(com.clean_record, [logEntries[i]]).then(() => {
                getHistoryLog(callback, i + 1);
            });
        } else {
            adapter.log.error('Could not find log entry');
            setImmediate(getHistoryLog, callback, i + 1);
        }
    }
}

function isEquivalent(a, b) {
    // Create arrays of property names
    const aProps = Object.getOwnPropertyNames(a);
    const bProps = Object.getOwnPropertyNames(b);

    // If number of properties is different,
    // objects are not equivalent
    if (aProps.length !== bProps.length) {
        return false;
    }

    for (let i = 0; i < aProps.length; i++) {
        const propName = aProps[i];

        // If values of same property are not equal,
        // objects are not equivalent
        if (a[propName] !== b[propName]) {
            return false;
        }
    }

    // If we made it this far, objects
    // are considered equivalent
    return true;
}

function makeTable(line) {
    // const head = clean_log_html_head;
    let html_line = '<tr>';

    html_line += '<td>' + line.Datum + '</td>' + '<td>' + line.Start + '</td>' + '<td ALIGN="RIGHT">' + line.Saugzeit + '</td>' + '<td ALIGN="RIGHT">' + line['Fläche'] + '</td>' + '<td ALIGN="CENTER">' + line.Error + '</td>' + '<td ALIGN="CENTER">' + line.Ende + '</td>';

    html_line += '</tr>';

    cleanLogHtmlAllLines += html_line;

    return '<table>' + clean_log_html_attr + clean_log_html_head + cleanLogHtmlAllLines + '</table>';

}

function enabledExpert() {
    if (adapter.config.enableSelfCommands) {
        adapter.log.info('Expert mode enabled, states created');
        adapter.setObjectNotExists('control.X_send_command', {
            type: 'state',
            common: {
                name: 'send command',
                type: 'string',
                read: true,
                write: true,
            },
            native: {}
        });
        adapter.setObjectNotExists('control.X_get_response', {
            type: 'state',
            common: {
                name: 'get response',
                type: 'string',
                read: true,
                write: false,
            },
            native: {}
        });


    } else {
        adapter.log.info('Expert mode disabled, states deleted');
        adapter.delObject('control.X_send_command');
        adapter.delObject('control.X_get_response');

    }

}

function enabledVoiceControl() {
    if (adapter.config.enableAlexa) {
        adapter.log.info('Create state clean_home for controlling by cloud adapter');

        adapter.setObjectNotExists('control.clean_home', {
            type: 'state',
            common: {
                name: 'Start/Home',
                type: 'boolean',
                role: 'state',
                read: true,
                write: true,
                desc: 'Start and go home',
                smartName: 'Staubsauger'
            },
            native: {}
        });

    } else {
        adapter.log.info('Cloud control disabled');
        adapter.delObject('control.clean_home');

    }

}

//create default states
function init() {
    adapter.getForeignObject('system.config', (err, systemConfig) => {
        if (systemConfig && systemConfig.common && systemConfig.common.language && systemDictionary.Sunday[systemConfig.common.language]) {
            userLang = systemConfig.common.language
            let obj
            for (let i in i18n) {
                obj = i18n[i]
                if (typeof obj == "string")
                    i18n[i] = systemDictionary[obj][userLang]
                else if (typeof obj == "object")
                    for (let o in obj)
                        obj[o] = systemDictionary[obj[o]][userLang]
            }
        }
    });
    adapter.setObjectNotExists('control.spotclean', {
        type: 'state',
        common: {
            name: 'Spot Cleaning',
            type: 'boolean',
            role: 'button',
            read: false,
            write: true,
            desc: 'Start Spot Cleaning',
            smartName: 'Spot clean'
        },
        native: {}
    });
    adapter.setObjectNotExists('control.sound_volume_test', {
        type: 'state',
        common: {
            name: 'sound volume test',
            type: 'boolean',
            role: 'button',
            read: false,
            write: true,
            desc: 'let the speaker play sound'
        },
        native: {}
    });
    adapter.setObjectNotExists('control.sound_volume', {
        type: 'state',
        common: {
            name: 'sound volume',
            type: 'number',
            role: 'level',
            read: true,
            write: true,
            unit: '%',
            min: 30,
            max: 100,
            desc: 'Sound volume of the Robot'
        },
        native: {}
    });

    adapter.setObjectNotExists('info.wifi_signal', {
        type: 'state',
        common: {
            name: 'Wifi RSSI',
            type: 'number',
            role: 'level',
            read: true,
            write: false,
            unit: 'dBm',
            desc: 'Wifi signal of the  vacuum'
        },
        native: {}
    });

    adapter.setObjectNotExists('info.device_model', {
        type: 'state',
        common: {
            name: 'device model',
            type: 'string',
            read: true,
            write: false,
            desc: 'model of vacuum',
        },
        native: {}
    });
    adapter.setObjectNotExists('info.device_fw', {
        type: 'state',
        common: {
            name: 'Firmware',
            type: 'string',
            read: true,
            write: false,
            desc: 'Firmware of vacuum',
        },
        native: {}
    });
    adapter.setObject('info.queue', {
        type: 'state',
        common: {
            name: 'Cleaning Queue',
            type: 'object',
            role: 'info',
            read: true,
            write: false
        },
        "native": {}
    }, function () {
        adapter.setState('info.queue', '', true);
    })
    adapter.setObjectNotExists('control.clearQueue', {
        type: 'state',
        common: {
            name: "clear cleaning queue",
            type: "boolean",
            role: "button",
            read: false,
            write: true,
            desc: "Clear cleaning queue, but not current job",
        },
        native: {}
    });
}

function checkWiFi(){
    nextWiFiCheck = new Date(new Date().getTime() + (adapter.config.wifiInterval || 86400000)); // if no wifi status update is needed, we want to get firmware/model once a day 
    callRobot(com.miIO_info.method).then(com.miIO_info.action).catch(function(err){
        if (err){ 
            adapter.log.warn(err.message + ' -> pause ' + com.miIO_info.method + ' try again in one hour')
            nextWiFiCheck = new Date(new Date().getTime() + 3600000) // try again in one hour
        }
        adapter.log.debug('Next WiFi check: ' + adapter.formatDate(nextWiFiCheck,'DD.MM hh:mm'))
    })
}

function sendPing() {
    pingTimeout && clearTimeout(pingTimeout);

    let now = new Date()
    if ((now - lastResponse) > maxResponseTime){ 
        // not connected or connection lost -> send Hello to Robot
        if (connected){ 
            connected = false;
            adapter.log.info('Disconnected due last Restponse of ' + adapter.formatDate(lastResponse,'hh:mm:ss.sss'));
        } else 
            for ( var i in messages){delete messages[i]}
        adapter.setState('info.connection', false, true);
        pingInterval= 20000; // check again in 20 seconds, sometimes the robo need some time to answer
        try {
            let commandPing = str2hex('21310020ffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
            server.send(commandPing, 0, commandPing.length, adapter.config.port, adapter.config.ip, function (err) {
                if (err) adapter.log.error('Cannot send ping: ' + err)
            });
        } catch (e) {
            adapter.log.warn('Cannot send ping: ' + e);
        }
    } else {
       // sendCommand(com.get_status, ['run_state','mode','err_state','battary_life','box_type','mop_type','s_time','s_area','suction_grade','water_grade','remember_map','has_map','is_mop','has_newmap'])
        if (now > nextWiFiCheck)
            checkWiFi()
        timerManager && timerManager.check()
    }
    pingTimeout = setTimeout(sendPing, pingInterval)
}

function serverConnected(){
    const now = parseInt(new Date().getTime() / 1000, 10); 
    const messageTime = parseInt(packet.stamprec.toString('hex'), 16);
    packet.timediff = messageTime - now === -1 ? 0 : (messageTime - now); // may be (messageTime < now) ? 0...
    if (packet.timediff !== 0) 
        adapter.log.warn('Time difference between Mihome Vacuum and ioBroker: ' + packet.timediff + ' sec');

    adapter.log.info('connecting, this can take up to 10 minutes ...')
    //sendCommand(com.get_status).then(() =>{
        lastResponse= new Date();
        if (!connected){ // it is the first successed call 
            connected = true;
            pingInterval= adapter.config.pingInterval;
            adapter.log.info('Connected');
            adapter.setState('info.connection', true, true);
            setTimeout(checkWiFi, 200)
            //setTimeout(sendCommand, 400, com.get_sound_volume)
            //setTimeout(sendCommand, 600, com.get_consumable)
			//setTimeout(sendCommand, 600, com.set_language, [2])
			
           // setTimeout(sendCommand, 800, com.clean_summary)
            setTimeout(features.detect, 1000)
            if (MAP.ENABLED)
                setTimeout(sendCommand, 1200, com.loadMap)
        }
   // })
}

function main() {
    adapter.setState('info.connection', false, true);
    adapter.config.port = parseInt(adapter.config.port, 10) || 54321;
    adapter.config.ownPort = parseInt(adapter.config.ownPort, 10) || 53421;
    adapter.config.pingInterval = parseInt(adapter.config.pingInterval, 10) || 20000;
    //adapter.log.info(JSON.stringify(adapter.config));

    init();
    Map = new maphelper(null, adapter);
    MAP.Init(); // for Map

    // Abfrageintervall mindestens 10 sec.
    if (adapter.config.pingInterval < 10000) {
        adapter.config.pingInterval = 10000;
    }

    maxResponseTime= Math.max(adapter.config.pingInterval, 60000) + 60000 // + some puffer

    if (!adapter.config.token) {
        adapter.log.error('Token not specified!');
        //return;
    } else {
        enabledExpert();
        enabledVoiceControl();




        packet = new MiHome.Packet(str2hex(adapter.config.token), adapter);

        packet.msgCounter = 1;

        server.on('error', function (err) {
            adapter.log.error('UDP error: ' + err);
            server.close();
            process.exit();
        });


        server.on('message', function (msg, rinfo) {
            if (rinfo.port === adapter.config.port) {
                if (msg.length === 32) {
                    adapter.log.debug('Receive <<< Hello <<< ' + msg.toString('hex'));
                    packet.setRaw(msg);
                    serverConnected()
                    
                } else {

                    //hier die Antwort zum decodieren
                    packet.setRaw(msg);
                    adapter.log.debug('Receive <<< ' + packet.getPlainData());
                    receiveMsgFromRobot(packet.getPlainData());
                }
            }
        });

        server.on('listening', function () {
            const address = server.address();
            adapter.log.debug('server started on ' + address.address + ':' + address.port);
        });

        try {
            server.bind(adapter.config.ownPort);
        } catch (e) {
            adapter.log.error('Cannot open UDP port: ' + e);
            return;
        }

        features.init()

        sendPing();

        adapter.subscribeStates('*');
        cleaning.clearQueue();
    }

}


/** Returns the only array element in a response */
function returnSingleResult(resp) {
    return resp.result[0];
}


/**
 * 
 * @param { object of {command, message, callback, from} obj 
 */
adapter.on('message',function(obj) {
    // responds to the adapter that sent the original message
    function respond(response) {
        if (obj.callback) adapter.sendTo(obj.from, obj.command, response, obj.callback);
    }

    // some predefined responses so we only have to define them once
    const predefinedResponses = {
        ACK: {
            error: null
        },
        OK: {
            error: null,
            result: 'ok'
        },
        ERROR_UNKNOWN_COMMAND: {
            error: 'Unknown command!'
        },
        MISSING_PARAMETER: paramName => {
            return {
                error: 'missing parameter "' + paramName + '"!'
            };
        }
    };

    // make required parameters easier
    function requireParams(params /*: string[] */ ) {
        if (!(params && params.length)) return true;
        for (let i = 0; i < params.length; i++) {
            const param = params[i];
            if (!(obj.message && obj.message.hasOwnProperty(param))) {
                respond(predefinedResponses.MISSING_PARAMETER(param));
                return false;
            }
        }
        return true;
    }

    // use jsdoc here
    function sendCustomCommand(
        method /*: string */ ,
        params /*: (optional) string[] */ ,
        parser /*: (optional) (object) => object */
    ) {
        // parse arguments
        if (typeof params === 'function') {
            parser = params;
            params = null;
        }
        if (parser && typeof parser !== 'function') {
            throw new Error('Parser must be a function');
        }
 
        callRobot(method, params).then(response => {
            if (parser) {
                // optionally transform the result
                response = parser(response);
            } else {
                // in any case, only return the result
                response = response.result;
            }
            // now respond with the result
            respond({
                error: null,
                result: response
            });
        }).catch(err => {
            // on error, respond immediately
            if (err) respond({
                error: err
            });
            // else wait for the callback
        })
        
    }

    // handle the message
    if (obj) {
        let params;

        switch (obj.command) {
            case 'discovery':
                //adapter.log.info('discover' + JSON.stringify(obj))
                Map.getDeviceStatus(obj.message.username, obj.message.password, obj.message.server, '{"getVirtualModel":false,"getHuamiDevices":0}').then(function (data) {
                        adapter.log.debug('discover__' + JSON.stringify(data));
                        respond(data)

                    })
                    .catch(function (err) {
                        adapter.log.info('discover ' + err)
                        respond({
                            error: err
                        })
                    })
                return;
                // call this with 
                // sendTo('mihome-vacuum.0', 'sendCustomCommand',
                //     {method: 'method_id', params: [...] /* optional*/},
                //     callback
                // );
            case 'sendCustomCommand':
                // require the method to be given
                if (!requireParams(['method'])) return;
                // params is optional

                params = obj.message;
                sendCustomCommand(params.method, params.params);
                return;

                // ======================================================================
                // support for the commands mentioned here:
                // https://github.com/MeisterTR/XiaomiRobotVacuumProtocol#vaccum-commands

                // cleaning commands
              case 'startVacuuming':
                if (cleaning.startCleaning(cleanStates.Cleaning, obj))
                    sendCustomCommand('set_mode_withroom',[0, 1, 0]);
                return;
            case 'stopVacuuming':
                sendCustomCommand('set_mode_withroom',[0, 2, 0]);
                return;
            case 'clearQueue':
                return cleaning.clearQueue();
            case 'cleanSpot':
                if (cleaning.startCleaning(cleanStates.SpotCleaning, obj))
                    sendCustomCommand('app_spot');
                return;
            case 'cleanZone':
                if (!obj.message) return adapter.log.warn("cleanZone needs paramter coordinates")
                if (!obj.zones){ // this data called first time!
                    let message = obj.message   
                    if (message.zones){ // called from roomManager with correct Array
                        obj.zones= message.zones
                        obj.channels= message.channels
                        obj.message= obj.zones.join(); // we use String for message
                    } else
                        obj.zones= [obj.message];
                }
                if (typeof obj.channels == "undefined"){
                    return roomManager.findChannelsByMapIndex(obj.zones, function(channels){
                        adapter.log.debug('search channels for ' + obj.message + ' ->' + channels.join());
                        obj.channels= channels && channels.length ? channels : null;
                        adapter.emit('message', obj); // call function again
                    })
                }
                if (cleaning.startCleaning(cleanStates.ZoneCleaning, obj))
                    sendCustomCommand('app_zoned_clean',obj.zones)
                
                return;
            case 'cleanSegments':
                if (!obj.message) return adapter.log.warn("cleanSegments needs paramter mapIndex")
                if (!obj.segments){ // this data called first time!
                    let message = obj.message   
                    if (message.segments){ // called from roomManager with correct Array
                        obj.segments= message.segments
                        obj.channels= message.channels
                        obj.message= obj.segments.join(); // we use String for message
                    } else{ // build correct Array
                        if (!isNaN(message))
                            message = [parseInt(message, 10)]
                        else {
                            if (typeof message == "string")
                                message = obj.message.split(",")
                            for (let i in message) {
                                message[i] = parseInt(message[i], 10);
                                if (isNaN(message[i]))
                                    delete message[i];
                            }
                        }
                        obj.segments= message;
                    }
                }
                if (typeof obj.channels == "undefined"){
                    return roomManager.findChannelsByMapIndex(obj.segments, function(channels){
                        adapter.log.debug('search channels for ' + obj.message + ' ->' + channels.join());
                        obj.channels= channels && channels.length ? channels : null;
                        adapter.emit('message', obj); // call function again
                    })
                }
                if (cleaning.startCleaning(cleanStates.RoomCleaning, obj))
  //setTimeout(()=> {cleaning.setRemoteState(cleanStates.RoomCleaning)},2500) //simulate:
                    sendCustomCommand('app_segment_clean', obj.segments)
                
                return;
            case 'cleanRooms':
                let rooms = obj.message // comma separated String with enum.rooms.XXX
                if (!rooms) return adapter.log.warn("cleanRooms needs paramter ioBroker room-id's")
                roomManager.findMapIndexByRoom(rooms, roomManager.cleanRooms)
                return;
            case 'pause':
                sendCustomCommand('app_pause');
                setTimeout(sendPing, 2000);
                return;
            case 'charge':
                sendCustomCommand('app_charge');
                setTimeout(sendPing, 2000);
                return;

                // TODO: What does this do?
            case 'findMe':
                sendCustomCommand('find_me');
                return;

                // get info about the consumables
                // TODO: parse the results
            case 'getConsumableStatus':
                sendCustomCommand('get_consumables', returnSingleResult);
                return;
            case 'resetConsumables':
                if (!requireParams(['consumable'])) return;
                sendCommand({method:'reset_consumable'},obj.message.consumable).then(answer =>{
                    sendCommand(com.get_consumable)
                })
                return;

                // get info about cleanups
            case 'getCleaningSummary':
                sendCustomCommand('get_clean_summary', parseCleaningSummary);
                return;
            case 'getCleaningRecord':
                // require the record id to be given
                if (!requireParams(['recordId'])) return;
                // TODO: can we do multiple at once?
                sendCustomCommand('get_clean_record', [obj.message.recordId], parseCleaningRecords);
                return;

                // TODO: find out how this works
                // case 'getCleaningRecordMap':
                //     sendCustomCommand('get_clean_record_map');
            case 'getMap':
                sendCustomCommand('get_map_v1');
                return;

                // Basic information
            case 'getStatus':
                sendCustomCommand('get_status', parseStatus);
                return;
            case 'getSerialNumber':
                sendCustomCommand('get_serial_number', function (resp) {
                    return resp.result[0].serial_number;
                });
                return;
            case 'getDeviceDetails':
                sendCustomCommand('miIO.info');
                return;

                // Do not disturb
            case 'getDNDTimer':
                sendCustomCommand('get_dnd_timer', returnSingleResult);
                return;
            case 'setDNDTimer':
                // require start and end time to be given
                if (!requireParams(['startHour', 'startMinute', 'endHour', 'endMinute'])) return;
                params = obj.message;
                sendCustomCommand('set_dnd_timer', [params.startHour, params.startMinute, params.endHour, params.endMinute]);
                return;
            case 'deleteDNDTimer':
                sendCustomCommand('close_dnd_timer');
                return;

                // Fan speed
            case 'getFanSpeed':
                // require start and end time to be given
                sendCustomCommand('get_custom_mode', returnSingleResult);
                return;
            case 'setFanSpeed':
                // require start and end time to be given
                if (!requireParams(['fanSpeed'])) return;
                sendCustomCommand('set_custom_mode', [obj.message.fanSpeed]);
                return;

                // Remote controls
            case 'startRemoteControl':
                sendCustomCommand('app_rc_start');
                return;
            case 'stopRemoteControl':
                sendCustomCommand('app_rc_end');
                return;
            case 'move':
                // require all params to be given
                if (!requireParams(['velocity', 'angularVelocity', 'duration', 'sequenceNumber'])) return;
                // TODO: Constrain the params
                params = obj.message;
                // TODO: can we issue multiple commands at once?
                const args = [{
                    omega: params.angularVelocity,
                    velocity: params.velocity,
                    seqnum: params.sequenceNumber, // <- TODO: make this automatic
                    duration: params.duration
                }];
                sendCustomCommand('app_rc_move', [args]);
                return;



                // ======================================================================

            default:
                respond(predefinedResponses.ERROR_UNKNOWN_COMMAND);
                return;
        }
    }
});

//------------------------------------------------------MAP Section
MAP.Init = function () {
    this.retries = 0
    this.mappointer = ""
    this.LASTMAPSAVE = Date.now();
    this.GETMAP = false;
    this.ENABLED = adapter.config.enableMiMap || adapter.config.valetudo_enable;
    // MAP initial
    this.MAPSAFEINTERVALL = parseInt(adapter.config.valetudo_MapsaveIntervall, 10) || 5000;
    this.POLLMAPINTERVALL = parseInt(adapter.config.valetudo_requestIntervall, 10) || 2000;
    this.ready = {
        login: false,
        mappointer: false
    }

    this.firstMap = true;

    if ((adapter.config.enableMiMap || adapter.config.valetudo_enable)) {
        adapter.setObjectNotExists('map.map64', {
            type: 'state',
            common: {
                name: 'Map64',
                type: 'string',
                read: true,
                write: false,
                desc: 'Map in a decoded Base64 PNG',
            },
            native: {}
        });
        adapter.setObjectNotExists('map.mapURL', {
            type: 'state',
            common: {
                name: 'MapURL',
                type: 'string',
                read: true,
                write: false,
                desc: 'Path to actual PNG File',
            },
            native: {}
        });

        adapter.setObjectNotExists('map.loadMap', {
            type: 'state',
            common: {
                name: 'load Map',
                type: "boolean",
                role: "button",
                read: false,
                write: true,
                desc: 'load the current Map',
            },
            native: {}
        });

        if (adapter.config.enableMiMap) {
            Map.login().then(function (anser) {
                //reqParams.push('get_map_v1'); todo: is this nessessary, or it is enough with mapPoll? 
                MAP.ready.login = true;
            }).catch(error => {
                adapter.log.warn(error);
            })
        } else if (adapter.config.valetudo_enable) {
            this._MapPoll()
        }

    }
}
MAP.updateMapPointer = function (answer) {
    let that = this;
    if (answer.split('%').length === 1) {
        if (typeof that.trys == "undefined")
            that.trys= 0;
        if ( that.trys < 10){
            setTimeout(function () {
                sendCommand(com.loadMap)
                adapter.log.debug(that.trys++ + '. Mappointer_nomap___' + answer)
            }, 500)
            return
        } else {
            adapter.log.warn('Could not receive Mappointer, giving up')
        }
    } else if (answer.split('%').length === 3) {
        that.mappointer = answer;
        adapter.log.debug('Mappointer_updated')
        that.ready.mappointer = true;
        if (that.firstMap) {
            that.firstMap = false;
            that._MapPoll() // for auth at server;

        }
    }
    delete that.trys;
}

MAP.getRoomsFromMap = function (answer) {
    let that = this;
    if (!adapter.config.enableMiMap) {
        return
    }
    adapter.log.debug('get rooms from map')
    if ((!that.ready.mappointer || !that.ready.login) && adapter.config.enableMiMap) {
        adapter.log.debug('get rooms from map pending...')
        setTimeout(sendCommand,20000,com.loadRooms)
        return
    }

    Map.updateMap(that.mappointer).then(function (data) {
            adapter.log.debug('get rooms from map data: ' + JSON.stringify(data[1]))
            let roomsarray = data[1]
            let roomids = []

            if (typeof (roomsarray) === 'undefined' || roomsarray.length === 0) return
 
            roomsarray.forEach(element => {
                roomids.push([element, 'room' + element])
            });

            answer.result = roomids
            roomManager.processRoomMaping(answer);
        })
        .catch(err => {})
}

MAP.StartMapPoll = function () {
    let that = this;
    if (!that.GETMAP && (adapter.config.enableMiMap || adapter.config.valetudo_enable)) {
        that.GETMAP = true;
        that._MapPoll();
    }
}

MAP._MapPoll = function () {
    let that = this;

    if ((!that.ready.mappointer || !that.ready.login) && adapter.config.enableMiMap) return

    Map.updateMap(that.mappointer).then(function (data) {
        if (data){
            let dataurl = data[0].toDataURL();

            adapter.setState('map.map64', '<img src="' + dataurl + '" style="width: auto ;height: 100%;" />', true);

            if (Date.now() - that.LASTMAPSAVE > that.MAPSAFEINTERVALL) {
                var buf = data[0].toBuffer();
                adapter.writeFile('mihome-vacuum.admin', 'actualMap_'+ adapter.instance +'.png', buf, function (error) {
                    if (error) {
                        adapter.log.error('Fehler beim Speichern der Karte');
                    } else {
                        adapter.setState('map.mapURL', '/mihome-vacuum.admin/actualMap_'+ adapter.instance +'.png', true);

                    }
                    that.LASTMAPSAVE = Date.now();
                })
            };
        }
            if (that.GETMAP) {
                //adapter.log.info(VALETUDO.POLLMAPINTERVALL)
                setTimeout(function () {
                    if(adapter.config.enableMiMap) sendCommand(com.loadMap); // get pointer only by mimap
                    that._MapPoll();
                }, that.POLLMAPINTERVALL);
            }


        })
        .catch(err => {
            adapter.log.debug(err);
            if (that.GETMAP) setTimeout(function () {
                if(adapter.config.enableMiMap) sendCommand(com.loadMap); // get pointer only by mimap
                that._MapPoll();
            }, that.POLLMAPINTERVALL);
        })

}
