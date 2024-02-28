var http = require('http');
var https = require('https');
var url = require('url');
var fs = require('fs');
var io = require('socket.io');
const redisocket  = require('redisocket');
var util = require('util');
var srvHelper = require('./srvhelper');
var localstore = require('./localstore');
var prefs = require('./prefs');
var serverPrefs = prefs.readPrefs('server');
var socketPrefs = prefs.readPrefs('socket');
var ip = serverPrefs.ip;
var port = serverPrefs.port;
var sslKeyPath = serverPrefs.sslKeyPath;
var sslCertPath = serverPrefs.sslCertPath;
var isPrivate = socketPrefs.private;
var isPublic = socketPrefs.public;
var socketAuthToken = socketPrefs.authToken;
var server;

//////////////////////////////////////// Create HTTP Server //////////////////////////////////////////////
// SSL HTTP
if ((sslKeyPath) && (sslCertPath)) {
    var sslOptions = {
        key: fs.readFileSync(sslKeyPath),
        cert: fs.readFileSync(sslCertPath)
    };
    server = https.createServer(sslOptions, function(req, res) {
        var lItems;
        var lUserId;
        var lRoom;
        var lTitle;
        var lMessage;
        var lTime;
        var lOptParam;
        var lType;
        var lJsonString;
        var parsedUrl = url.parse(req.url, true);
        var path = parsedUrl.pathname;
        var fullPath = parsedUrl.path;
        prefs.doLog('Remote IP:', req.connection.remoteAddress);
        prefs.doLog('Path:', path);
        prefs.doLog('Full Path:', fullPath);
        prefs.doLog('User Agent:', req.headers['user-agent']);
        // HTTP Basic Auth
        if (srvHelper.doBasicAuth(req, res)) {
            if (path == '/' && fullPath.length == path.length) {
                srvHelper.serveIndex(res);
            } else if (path == '/testclient') {
                srvHelper.serveClient(res);
            } else if (path == '/notifyuser') {
                lItems = srvHelper.getNotifyInfo(req, res);
                if (lItems) {
                    lUserId = lItems.userid;
                    lRoom = lItems.room;
                    lType = lItems.type;
                    lTitle = lItems.title;
                    lMessage = lItems.message;
                    lTime = lItems.time;
                    lOptParam = lItems.optparam;
                    prefs.doLog(lUserId + ' ' + lRoom + ' ' + lType + ' ' + lTitle + ' ' + lMessage + ' ' + lOptParam + ' ' + lTime);
                    socketio.sendNotify(lUserId, lRoom, lType, lTitle, lMessage, lOptParam, lTime, function() {
                        res.end();
                    });
                }
            } else if (path == '/status') {
                res.writeHead(200, {
                    'Content-Type': 'text/plain'
                });
                socketio.getSocketInfo(function(returnText) {
                    lStatusText = returnText;
                    res.write(lStatusText);
                    res.end();
                });
            } else {
                srvHelper.throwHttpError(404, 'Not Found', res);
            }
        }
    });
    // Standard HTTP
} else {
    server = http.createServer(function(req, res) {
        var lItems;
        var lUserId;
        var lType;
        var lRoom;
        var lTitle;
        var lMessage;
        var lTime;
        var lOptParam;
        var lStatusText;
        var parsedUrl = url.parse(req.url, true);
        var path = parsedUrl.pathname;
        var fullPath = parsedUrl.path;
        prefs.doLog('Remote IP:', req.connection.remoteAddress);
        prefs.doLog('Path:', path);
        prefs.doLog('Full Path:', fullPath);
        prefs.doLog('User Agent:', req.headers['user-agent']);
        // HTTP Basic Auth
        if (srvHelper.doBasicAuth(req, res)) {
            // index html with overview of services
            if (path == '/' && fullPath.length == path.length) {
                srvHelper.serveIndex(res);
            } else if (path == '/testclient') {
                srvHelper.serveClient(res);
            } else if (path == '/notifyuser') {
                lItems = srvHelper.getNotifyInfo(req, res);
                if (lItems) {
                    lUserId = lItems.userid;
                    lRoom = lItems.room;
                    lType = lItems.type;
                    lTitle = lItems.title;
                    lMessage = lItems.message;
                    lTime = lItems.time;
                    lOptParam = lItems.optparam;
                    prefs.doLog(lUserId + ' ' + lRoom + ' ' + lType + ' ' + lTitle + ' ' + lMessage + ' ' + lOptParam + ' ' + lTime);
                    socketio.sendNotify(lUserId, lRoom, lType, lTitle, lMessage, lOptParam, lTime, function() {
                        res.end();
                    });
                }
            } else if (path == '/status') {
                res.writeHead(200, {
                    'Content-Type': 'text/plain'
                });
                socketio.getSocketInfo(function(returnText) {
                    lStatusText = returnText;
                    res.write(lStatusText);
                    res.end();
                });
            } else {
                srvHelper.throwHttpError(404, 'Not Found', res);
            }
        }
    });
}
server.listen(port, ip);
if ((sslKeyPath) && (sslCertPath)) {
    prefs.doLog('HTTPS Server listening on ' + ip + ':' + port);
} else {
    prefs.doLog('HTTP Server listening on ' + ip + ':' + port);
}
////////////////////////////////////////////////////// Socket.io ////////////////////////////////////////////
var listener = io.listen(server, {
    transports: ['websocket'],
    upgradeTimeout: 10000,
    pingInterval: 10000,
    pingTimeout: 50000,
    cookie: false,
});
if (isPrivate) {
    var ioPrivate = listener.of('/private');
}
if (isPublic) {
    var ioPublic = listener.of('/public');
}
////////////////////////////////////////////////////////// Redis //////////////////////////////////////////
var redisAdapter = redisocket({
    host: serverPrefs.redisHost,
    port: serverPrefs.redisPort,
    // key: 'socket.io', //Default. Redis SUB channel is 'socket.io#/<public/private>#'
});
listener.adapter(redisAdapter);
////////////////////////////////////////////////////// Callbacks ////////////////////////////////////////////
var socketio = {
    connectSockets: function () {
        // Private connect
        if (isPrivate) {
            ioPrivate.on("connection", function (socket) {
                var userid = socket.handshake.query.userid;
                var authToken = socket.handshake.query.authtoken;
                // check authToken
                if (authToken == socketAuthToken) {
                    socket.userid = userid;
                    prefs.doLog(userid + " connected to Private");
                    // save session
                    localstore.saveUserSession(
                        userid,
                        "private",
                        socket.id,
                        function () {
                            prefs.doLog(
                                userid + " private session saved in DB"
                            );
                        }
                    );
                } else {
                    // token error
                    prefs.doLog(userid + " with wrong authToken: " + authToken);
                    socket.disconnect();
                }
            });
        }
        // Public connect
        if (isPublic) {
            ioPublic.on("connection", function (socket) {
                var userid = socket.handshake.query.userid;
                var authToken = socket.handshake.query.authtoken;
                // check authToken
                if (authToken == socketAuthToken) {
                    // token success
                    socket.userid = userid;
                    prefs.doLog(userid + " connected to Public");
                    // save session
                    localstore.saveUserSession(
                        userid,
                        "public",
                        socket.id,
                        function () {
                            prefs.doLog(userid + " public session saved in DB");
                        }
                    );
                } else {
                    // token error
                    prefs.doLog(userid + " with wrong authToken: " + authToken);
                    socket.disconnect();
                }
            });
        }
    },
    sendNotify: function (
        pUserId,
        pRoom,
        pType,
        pTitle,
        pMessage,
        pOptParam,
        pTime,
        callback
    ) {
        if (pRoom === "private" && isPrivate) {    
            try {
                (async function () {
            const dbres = await localstore.getUserSession(pUserId, pRoom);
            console.log(dbres);
            if (dbres) {
                dbres.forEach(function (dbItem) {
                    var lSessionid = dbItem.session;
                    ioPrivate.to(lSessionid).emit("message", {
                        type: pType,
                        title: pTitle,
                        message: pMessage,
                        time: pTime,
                        optparam: pOptParam,
                    });
                });
            }
        })();
    } catch (err) {
        prefs.doLog(pUserId, "Error receiving User DB session: " + err);
    }
    callback();
        }
        // For public messages, emit to the room without fetching individual sessions
        else if (pRoom === "public" && isPublic) {
            ioPublic.emit("message", {
                type: pType,
                title: pTitle,
                message: pMessage,
                time: pTime,
                optparam: pOptParam,
            });
            callback();
        }
    },
    getSocketInfo: function (callback) {
        var lReturnText;
        var lCount;
        lReturnText = "CONNECTED CLIENTS COUNTER:" + "\n";
        // private
        if (isPrivate) {
            lCount = Object.keys(ioPrivate.connected).length;
            lReturnText =
                lReturnText + "Connected to Private: " + lCount + "\n";
        }
        // public
        if (isPublic) {
            lCount = Object.keys(ioPublic.connected).length;
            lReturnText =
                lReturnText + "Connected to Public: " + lCount + "\n" + "\n";
        }
        // DB stats
        lReturnText = lReturnText + "DATABASE STATS:" + "\n";
        // DB stats info
        localstore.getDbStats(function (err, dbres) {
            if (dbres) {
                dbres.forEach(function (dbItem) {
                    lReturnText =
                        lReturnText +
                        dbItem.room +
                        ": " +
                        dbItem.counter +
                        " entries" +
                        "\n";
                });
            }
            if (err) {
                prefs.doLog(pUserId, "Error receiving DB stats: " + err);
                return callback("Error");
            }
            callback(lReturnText);
        });
        prefs.doLog(lReturnText);
    },
};
// connect sockets
socketio.connectSockets();
// delete user session older than 3 hours
srvHelper.deleteOldSessions();
