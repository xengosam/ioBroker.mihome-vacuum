const request = require('request');
const zlib = require('zlib');
const RRMapParser = require('./RRMapParser');
//const mapCreator = require('./mapCreator');
// libs for Cloudmap
const TreeMap = require('treemap-js');
let crypto = require('crypto');

//load if map is selected
let mapCreator = {
    load: function (callback) {
        try {
            mapCreator = require('./mapCreator');
            return true
        } catch (error) {
            //adapter.log.error(error)
            return false
        }
    }
};


let ssecurity = '';
let serviceToken = '';
let userId = '';
let mapUrlCache = [];

//helpermap just for dev
let maptest = '["robomap%2F74476450%2F0"]';

class Maphelper {
    constructor(options, adapter) {
        if (typeof (adapter) === 'undefined') adapter = adapter_helper;

        let did;
        try {
            did = JSON.parse(adapter.config.devices).did;
        } catch (error) {
            //adapter.log.error(error)
        }
        this.adapter = adapter;
        this.ready = false;

        this.config = {
            username: adapter && adapter.config && adapter.config.email ? adapter.config.email : '',
            password: adapter && adapter.config && adapter.config.password ? adapter.config.password : '',
            deviceId: did ? did : '',
            clientId: Math.random().toString(36).replace(/[^a-z]+/g, '').substr(0, 6),
            server: adapter && adapter.config && adapter.config.server ? adapter.config.server : '-',
            valetudo: adapter && adapter.config && adapter.config.valetudo_enable ? adapter.config.valetudo_enable : false,
            mimap: adapter && adapter.config && adapter.config.enableMiMap ? adapter.config.enableMiMap : false,
            ip: adapter && adapter.config && adapter.config.ip ? adapter.config.ip : '',
            COLOR_OPTIONS: {
                'FLOORCOLOR': adapter.config.valetudo_color_floor,
                'WALLCOLOR': adapter.config.valetudo_color_wall,
                'PATHCOLOR': adapter.config.valetudo_color_path,
                'ROBOT': adapter.config.robot_select,
                'newmap': adapter && adapter.config && adapter.config.newmap ? adapter.config.newmap : false
            }
        };
        if (this.config.valetudo || this.config.mimap) adapter.log.debug('load Map creator... '+ mapCreator.load());

        //this.adapter.log.debug("Maphelper_config___" + JSON.stringify(this.config));
        //this.login();
    }


    getRawMapData(urlstring) {
        let self = this;
        let url;
    
        // micloud
        if ((typeof (urlstring) !== 'undefined') && self.config.mimap) {
            url = urlstring;
        }
        // Valetudo
        else {
            url = 'http://' + self.config.ip + '/api/map/latest';
        }
    
        let options = {
            url: url
        };
    
        let requestWithEncoding = function (options, callback) {
            let req = request.get(options);
    
            req.on('response', function (res) {
                let chunks = [];
                if (res.statusCode !== 200){
                    if(res.statusCode === 404 ||res.statusCode === "404") callback('wrong server selected___' + JSON.stringify(res), null);
                    else callback('no map found on server___' + JSON.stringify(res), null);
                    return
                }
                if(res.statusCode === 404 ||res.statusCode === "404")
                self.adapter.log.debug('Mapresponse_ ' + JSON.stringify(res));
                res.on('data', function (chunk) {
                    chunks.push(chunk);
                });
    
                res.on('end', function () {
                    let buffer = Buffer.concat(chunks);
    
                    try {
                        if (buffer[0x00] === 0x1f && buffer[0x01] === 0x8b) { // gzipped data
                            zlib.gunzip(buffer, function (err, decoded) {
                                callback(err, RRMapParser.PARSEDATA(decoded));
                            });
                        } else {
                            callback(null, JSON.parse(buffer));
                        }
                    } catch (e) {
                        callback(e, null);
                    }
                });
            });
    
            req.on('error', function (err) {
                callback(err);
            });
        };
    
        // Return new promise 
        return new Promise(function (resolve, reject) {
    
            requestWithEncoding(options, function (err, data) {
                if (err) {
                    reject(err);
                } else {
                    //console.log(JSON.stringify(data));
                    //let map = mapCreator.CanvasMap(data);
                    resolve(data);
                }
            });
        });
    };

    getMapBase64 (url) {
        let self = this;

        return new Promise(function (resolve, reject) {

            self.getRawMapData(url).then(function (data) {
                    let map = mapCreator.CanvasMap(data, self.config.COLOR_OPTIONS, self.adapter);
                    //console.log('<img src="' + map.toDataURL() + '" /style="width: auto ;height: 100%;">')
                    resolve([map, data.image.segments.id]);
                })
                .catch(error => reject(error));

        });
    };

    
    login(username, password) {
        let self = this;

        if (username === undefined) {
            username = self.config.username;
        } else {
            serviceToken = null;
        }

        if (password === undefined) {
            password = self.config.password;
        } else {
            serviceToken = null;
        }

        return new Promise(function (resolve, reject) {
            if (!username.trim() || !password.trim()) {
                self.adapter.log.error('Xiaomi Cloud: username or password missing.');
                reject('Xiaomi Cloud username or password missing.');
                return;
            }

            if (serviceToken) {
                resolve(true);
                return;
            } else {
                self.adapter.log.debug('Xiaomi Cloud: Logging in');
            }

            // Set the headers for the request
            let headers = {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Android-7.1.1-1.0.0-ONEPLUS A3010-136-9D28921C354D7 APP/xiaomi.smarthome APPV/62830',
                'Cookie': 'sdkVersion=accountsdk-18.8.15; userId=' + username + '; deviceId=' + self.config.clientId
            };

            // Configure the request
            let options = {
                url: 'https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiio&_json=true',
                method: 'GET',
                headers: headers,
                gzip: true
            };

            // Start the request
            request(options, function (error, response, body) {
                if (!error && response.statusCode === 200) {
                    // Print out the response body
                    //console.log({status: 0, statusDsc: 'success', data: body});
                    let jsonData = parseJson(body);

                    if (jsonData == false) {
                        reject('Failed to get sign variable');
                        return;
                    }

                    headers.Cookie = 'sdkVersion=accountsdk-18.8.15; deviceId=' + self.config.clientId;

                    let options = {
                        url: 'https://account.xiaomi.com/pass/serviceLoginAuth2',
                        method: 'POST',
                        headers: headers,
                        form: {
                            'sid': 'xiaomiio',
                            'hash': encodePassword(password),
                            'callback': 'https://sts.api.io.mi.com/sts',
                            'qs': '%3Fsid%3Dxiaomiio%26_json%3Dtrue',
                            'user': username,
                            '_sign': jsonData._sign,
                            '_json': 'true'
                        },
                        gzip: true
                    };

                    //headers.length = postBody.length;
                    request(options, function (error, response, body) {
                        if (!error && response.statusCode === 200) {
                            // Print out the response body
                            //console.log({status: 0, statusDsc: 'success', data: body});
                            let jsonData = parseJson(body);

                            if (jsonData.code != 0) {
                                reject('Login failed');
                                return;
                            }

                            ssecurity = jsonData.ssecurity;
                            userId = jsonData.userId;
                            //cUserId = jsonData.cUserId;

                            const j = request.jar();
                            let options = {
                                url: jsonData.location,
                                method: 'GET',
                                headers: headers,
                                gzip: true,
                                jar: j
                            };

                            request(options, function (error, response, body) {
                                if (!error && response.statusCode === 200) {
                                    const cookies = j.getCookies('https://sts.api.io.mi.com/');

                                    let found = false;
                                    cookies.forEach(cookie => {
                                        if (cookie.key === 'serviceToken') {
                                            serviceToken = cookie.value;
                                            found = true;
                                            //console.log(serviceToken);
                                            self.adapter.log.debug('Xiaomi Cloud: Login successful');
                                            self.ready = true;
                                            resolve(true);
                                            return;
                                        }
                                    });

                                    if (!found) {
                                        reject('Token cookie not found');
                                        return;
                                    }
                                } else {
                                    self.adapter.log.error('HTTP error when getting token cookie' + JSON.stringify(error));
                                    reject('HTTP error when getting token cookie');
                                }
                            });
                        } else {
                            self.adapter.log.error('HTTP error when logging in' + JSON.stringify(error));
                            reject('HTTP error when logging in');
                        }
                    });
                } else {
                    self.adapter.log.error('HTTP error when getting _sign' + JSON.stringify(error));
                    reject('HTTP error when getting _sign')
                }
            });
        });
    };

    
    updateMap(mapurl, dontRetry) {
        let self = this;
        return new Promise(function (resolve, reject) {
    
            // if mimap is selected
            if (self.config.mimap === true) {
                self.adapter.log.debug('update_Map Mimap enabled');
                if (dontRetry == true && serviceToken != undefined) {
                    self.adapter.log.debug('dont retry');
                    reject("dont repeat");
                }
                let unixtime = Math.floor(new Date() / 1000);
                if (mapUrlCache[mapurl] == undefined || mapUrlCache[mapurl].expires < (unixtime - 60)) {
                    self.adapter.log.debug('update_Map need new mapurl');
                    getMapURL.call(self, mapurl).then(function (result) {
    
                        mapUrlCache[mapurl] = {
                            expires: result.result.expires_time,
                            url: result.result.url
                        };

                        self.adapter.log.debug('update_Map got new url:' + mapUrlCache[mapurl].url);
                        self.adapter.log.debug('update_Map got new expires:' + mapUrlCache[mapurl].expires);
                        self.adapter.log.debug('update_Map got new time:' + unixtime);
                        self.getMapBase64(mapUrlCache[mapurl].url)
                            .then(mapdata => resolve(mapdata))
                            .catch(error => reject(error));
                    }).catch(error => {
                        //reject(error);
                        if (!dontRetry) {
                            self.login()
                                .then(reponse => self.updateMap(mapurl, true))
                                .catch(error => reject(error));
                        }
                    });
                } else {
                    self.adapter.log.debug('update_Map use old mapurl');
                    self.getMapBase64(mapUrlCache[mapurl].url)
                        .then(mapdata => resolve(mapdata))
                        .catch(error => reject(error));
                }
            } else if (self.config.valetudo === true) {
                self.getMapBase64()
                    .then(mapdata => resolve(mapdata))
                    .catch(error => reject(error));
            }
        });
    };
    
    getDeviceStatus (username, password, server, obj) {
        let self = this;
    
        return new Promise((resolve, reject) =>
            self.login(username, password)
                .then(resp => {
                    let url;
                    if (server === '-'){
                        url = 'https://api.io.mi.com/app/home/device_list';
                    } else{
                        url = 'https://' + server + '.api.io.mi.com/app/home/device_list';
                    }
                    let headers = {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
                        'User-Agent': 'Android-7.1.1-1.0.0-ONEPLUS A3010-136-9D28921C354D7 APP/xiaomi.smarthome APPV/62830',
                        'Cookie': 'userId=' + userId + '; yetAnotherServiceToken=' + serviceToken + '; serviceToken=' + serviceToken + '; locale=de_DE; timezone=GMT%2B01%3A00; is_daylight=1; dst_offset=3600000; channel=MI_APP_STORE',
                    };

                    let params = [{
                        key: 'data',
                        //value: '{"dids":["117978555"]}'
                        value: obj
                    }];

                    let body = generateSignature('/home/device_list', params);

                    let options = {
                        url: url,
                        method: 'POST',
                        headers: headers,
                        form: body,
                        gzip: true
                    };

                    self.adapter.log.debug('GET devices from:'+ url);

                    request(options, (error, response, body) => {
                        if (!error && response.statusCode === 200) {
                            self.adapter.log.debug(body);
                            let json = JSON.parse(response.body);
                            if (json.message === 'ok')
                                resolve(json.result.list);
                            else
                                reject(json.message);
                            /*if(json.message == 'ok') {
                              resolve(json);
                            }
                            else {
                              serviceToken = undefined;
                              reject(json.message);
                            }*/
                            return;
                        }
                        self.adapter.log.info(JSON.stringify(response));
                        self.adapter.log.error(JSON.stringify(error));
                        serviceToken = undefined;
                        reject('HTTP ERROR');
                    });
                })
                .catch(error => reject(error)));
    };
}


// just for testing 
//-----------------------------------
let adapter_helper = {

    log: {
        info: function (msg) {
            console.log('INFO: ' + msg);
        },
        error: function (msg) {
            console.log('ERROR: ' + msg);
        },
        debug: function (msg) {
            console.log('DEBUG: ' + msg);
        },
        warn: function (msg) {
            console.log('WARN: ' + msg);
        }
    },
    msg: {
        info: [],
        error: [],
        debug: [],
        warn: []
    }
};
//------------------------------------

function encodePassword(password) {
    return crypto.createHash('md5').update(password).digest('hex').toUpperCase();
}

function parseJson(data) {
    if (data.includes('&&&START&&&')) {
        return JSON.parse(data.replace('&&&START&&&', ''));
    } else {
        return false;
    }
}

function generateSignature(path, params) {
    let nonce = crypto.randomBytes(16);
    nonce.writeInt32LE(new Date().getTime() / 60000);
    nonce = nonce.toString('base64');

    let b = Buffer.from(crypto.randomBytes(8));
    let millis = Buffer.allocUnsafe(4);
    millis.writeUInt32BE(Math.round(new Date().getTime() / 60000));
    nonce = Buffer.concat([b, millis]).toString('base64');

    let signature = crypto.createHash('sha256').update(Buffer.concat([Buffer.from(ssecurity, 'base64'), Buffer.from(nonce, 'base64')])).digest('base64');

    let paramsTreeMap = new TreeMap();

    params.forEach(element =>
        paramsTreeMap.set(element.key, element.value));

    let paramsArray = Array();
    if (path != null) {
        paramsArray.push(path);
    }

    paramsArray.push(signature);
    paramsArray.push(nonce);

    if (paramsTreeMap.getLength() > 0) {
        paramsTreeMap.each((value, key) =>
            paramsArray.push(key + '=' + value));
    } else {
        paramsArray.push('data=');
    }

    let postData = '';
    paramsArray.forEach(value => {
        if (postData) {
            postData += '&';
        }

        postData += value;
    });

    let body = {
        'signature': HashHmacSHA256(postData, signature),
        '_nonce': nonce
    };

    paramsTreeMap.each((value, key) => body[key] = value);
    return body;
}

function HashHmacSHA256(data, secret) {
    let hmac = crypto.createHmac('sha256', Uint8Array.from(Buffer.from(secret, 'base64')));
    //passing the data to be hashed
    data = hmac.update(data);
    //Creating the hmac in the required format
    return data.digest('base64');
}


function getMapURL(mapName) {
    const self = this;

    return new Promise((resolve, reject) => {
        let url;
        if (self.config.server === '-') {
            url = 'https://api.io.mi.com/app/home/getmapfileurl';
        } else{
            url = 'https://' + self.config.server + '.api.io.mi.com/app/home/getmapfileurl';
        }

        let headers = {
            'Content-Type': 'application/x-www-form-urlencoded',
            'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
            'User-Agent': 'Android-7.1.1-1.0.0-ONEPLUS A3010-136-9D28921C354D7 APP/xiaomi.smarthome APPV/62830',
            'Cookie': 'userId=' + userId + '; yetAnotherServiceToken=' + serviceToken + '; serviceToken=' + serviceToken + '; locale=de_DE; timezone=GMT%2B01%3A00; is_daylight=1; dst_offset=3600000; channel=MI_APP_STORE',
        };

        let params = [{
            key: 'data',
            value: '{"obj_name":"' + mapName + '"}'
        }];

        let body = generateSignature('/home/getmapfileurl', params);

        let options = {
            url: url,
            method: 'POST',
            headers: headers,
            form: body,
            gzip: true
        };

        request(options, (error, response, body) => {
            if (!error && response.statusCode === 200) {
                let json = JSON.parse(response.body);

                if (json.message === 'ok') {
                    resolve(json);
                } else {
                    self.adapter.log.error('Error when receiving mapurl: ' + JSON.stringify(json));
                    serviceToken = undefined;
                    reject(json.message);
                }
                return;
            }

            serviceToken = undefined;

            try {
                if (error) {
                    reject(error);
                    self.adapter.log.warn('Get Error when receiving mapurl:' + error)
                } else {
                    let json = JSON.parse(response.body);
                    self.adapter.log.warn(JSON.stringify(response));
                    reject(json.message);
                }
            } catch (err) {
                reject(err);
            }
        });
    });
}

module.exports = Maphelper;