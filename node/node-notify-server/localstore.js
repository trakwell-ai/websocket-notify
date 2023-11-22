const Redis = require("ioredis");
const redis = new Redis(); // Default to 127.0.0.1:6379, you can pass your own config
const prefs = require("./prefs");

module.exports = {
    // format date to YYYYMMDDmmss
    dateFormat: function (pDate) {
        function pad2(number) {
            return (number < 10 ? "0" : "") + number;
        }
        pDate = new Date();
        var yyyy = pDate.getFullYear().toString();
        var MM = pad2(pDate.getMonth() + 1);
        var dd = pad2(pDate.getDate());
        var hh = pad2(pDate.getHours());
        var mm = pad2(pDate.getMinutes());
        var ss = pad2(pDate.getSeconds());

        return yyyy + MM + dd + hh + mm + ss;
    },
    // format date to DD.MM.YYYY HH24:MI
    dateTimeFormat: function (pDate) {
        function pad2(number) {
            return (number < 10 ? "0" : "") + number;
        }
        pDate = new Date();
        var yyyy = pDate.getFullYear().toString();
        var MM = pad2(pDate.getMonth() + 1);
        var dd = pad2(pDate.getDate());
        var hh = pad2(pDate.getHours());
        var mm = pad2(pDate.getMinutes());

        return dd + "." + MM + "." + yyyy + " " + hh + ":" + mm;
    },
    // Save Client Session in Redis
    saveUserSession: function (userId, socketRoom, socketSessionId, callback) {
        const userKey = `user:${userId.toUpperCase()}`;
        const roomKey = `room:${socketRoom.toUpperCase()}`;
        const sessionKey = `session:${socketSessionId}`;
        const sessionListKey = `sessions:${userId.toUpperCase()}`; // Key for the list of sessions
        const now = Date.now();

        // Start a transaction
        const pipeline = redis.pipeline();

        // Add new session to the list of sessions for this user
        pipeline.rpush(
            sessionListKey,
            JSON.stringify({
                room: socketRoom.toUpperCase(),
                session: socketSessionId,
                created: now,
            })
        );

        // Store session data within a hash
        pipeline.hset(userKey, "room", socketRoom.toUpperCase());
        pipeline.hset(userKey, "session", socketSessionId);
        pipeline.hset(userKey, "created", now);

        // Add to room set for easy retrieval
        pipeline.sadd(roomKey, userId.toUpperCase());

        // Set a session key for easy session retrieval/deletion
        pipeline.set(sessionKey, userId.toUpperCase());

        // Execute the transaction
        pipeline.exec((err, results) => {
            if (err) {
                prefs.doLog("Redis - Insert user ERROR", err);
                return callback(err);
            }
            prefs.doLog("Redis - Insert user DONE");
            callback(null, results);
        });
    },

    // Get all User Sessions from Redis
    // Get all User Sessions from Redis
    getUserSession: function (userId, socketRoom, callback) {
        const userKey = `user:${userId.toUpperCase()}`;
        const roomKey = `room:${socketRoom.toUpperCase()}`;
        const sessionListKey = `sessions:${userId.toUpperCase()}`; // Key for the list of sessions

        if (
            userId.toUpperCase() === "ALL" &&
            socketRoom.toUpperCase() === "PUBLIC"
        ) {
            // Retrieve all sessions in the room
            redis.smembers(roomKey, (err, userIds) => {
                if (err) {
                    prefs.doLog("Redis - Select user sessions ERROR", err);
                    return callback(err);
                }
                // Fetch each user's sessions
                const sessionPromises = userIds.map((id) => {
                    return new Promise((resolve, reject) => {
                        redis.lrange(
                            `sessions:${id}`,
                            0,
                            -1,
                            (error, sessions) => {
                                if (error) {
                                    reject(error);
                                } else {
                                    resolve(
                                        sessions.map((session) =>
                                            JSON.parse(session)
                                        )
                                    );
                                }
                            }
                        );
                    });
                });
                Promise.all(sessionPromises)
                    .then((results) => {
                        prefs.doLog("Redis - Select user sessions DONE");
                        callback(null, results);
                    })
                    .catch((error) => {
                        prefs.doLog(
                            "Redis - Select user sessions ERROR",
                            error
                        );
                        callback(error);
                    });
            });
        } else {
            // Get sessions for a specific user
            redis.lrange(sessionListKey, 0, -1, (err, sessions) => {
                if (err) {
                    prefs.doLog("Redis - Select user session ERROR", err);
                    return callback(err);
                }
                const parsedSessions = sessions.map((session) =>
                    JSON.parse(session)
                );
                prefs.doLog("Redis - Select user session DONE");
                callback(null, parsedSessions);
            });
        }
    },

    // Delete Sessions older than 2 hours
    deleteOldSessions: function(callback) {
        var lDate = new Date();
        lDate = lDate.setHours(lDate.getHours() - 2);
        var lDateFormat = module.exports.dateFormat(lDate);

        client.keys("user:*", (err, key) => {
            if (err) {
                prefs.doLog("REDIS - Get key ERROR", err)
                callback(err)
                return
            }

            const keyToDelete = key.filter(k => {
                const sessionCreatedDate = k.split(":")[2]
                return sessionCreatedDate < lDateFormat
            })

            if (keyToDelete.length > 0) {
                client.del(keyToDelete, (delErr, res) => {
                    if (delErr) {
                        prefs.doLog("REDIS - delete Old session ERROR", delErr)
                        callback(delErr)
                    } else {
                        prefs.doLog("REDIS - delete Old Session DONE")
                        callback(res)
                    }
                })
            } else {
                prefs.doLog("REDIS - No Old SESSION TO Delete")
                callback([])
            }
        })
    },
    // Get DB stats
    getDbStats: function(callback) {
        client.keys('users:*', (err, keys) => {
            if (err) {
                console.error('Redis - Get keys ERROR', err);
                callback(err);
                return;
            }
            const pipeline = client.pipeline();
            keys.forEach((key) => {
                pipeline.hget(key, 'room');
            });

            pipeline.exec((pipelineErr, results) => {
                if (pipelineErr) {
                    prefs.doLog('Redis - Pipeline execution ERROR', pipelineErr);
                    callback(pipelineErr);
                    return;
                }
                // Sir this object represents the count of occurrences for each unique 'room' value ok?
                const stats = results.reduce((acc, [room]) => {
                    acc[room] = (acc[room] || 0) + 1;
                    return acc;
                }, {});

                prefs.doLog('Redis - Select DB stats DONE');

                callback(stats);
            });
        });
    }}
