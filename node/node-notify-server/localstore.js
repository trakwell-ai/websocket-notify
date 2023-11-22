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
    deleteOldSessions: function (callback) {
        // This operation is complex as Redis does not support direct querying.
        // An alternative method would be to use Redis' EXPIRE feature at the time of session creation.
        // For this example, we'll just log that this operation is not directly supported.
        prefs.doLog("Redis - Delete users not directly supported");
        callback(new Error("Operation not supported"));
    },

    // Get DB stats (Redis does not support direct querying like SQL, this function would have to be rethought)
    getDbStats: function (callback) {
        // This operation is not directly supported by Redis as it is by SQL databases.
        prefs.doLog("Redis - Select DB stats not directly supported");
        callback(new Error("Operation not supported"));
    },
};

// Additional setup or periodic tasks may be required to handle deletion of old sessions or gathering statistics.
