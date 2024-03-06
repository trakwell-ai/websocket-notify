const Redis = require("ioredis");
const prefs = require("./prefs");
const redis = new Redis({
    host: prefs.readPrefs("server").redisHost, 
    port: prefs.readPrefs("server").redisPort, 
}); 

module.exports = {
    // format date to YYYYMMDDmmss
    dateFormat: function (pDate) {
        const pad2 = (number) => number.toString().padStart(2, "0");
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
        return `${dd}.${MM}.${yyyy} ${hh}:${mm}`;
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
        pipeline.hset(userKey, "room", socketRoom.toUpperCase());
        pipeline.hset(userKey, "session", socketSessionId);
        pipeline.hset(userKey, "created", now);
        pipeline.sadd(roomKey, userId.toUpperCase());
        pipeline.set(
            sessionKey,
            userId.toUpperCase(),
            "EX",
            prefs.readPrefs("socket").timeToLive
        );
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
    getUserSession: async function (userId, socketRoom) {
        try {
            const userKey = `user:${userId.toUpperCase()}`;
            const roomKey = `room:${socketRoom.toUpperCase()}`;
            const sessionListKey = `sessions:${userId.toUpperCase()}`; // Key for the list of sessions
            if (
                userId.toUpperCase() === "ALL" &&
                socketRoom.toUpperCase() === "PUBLIC"
            ) {
                // Retrieve all sessions in the room
                const userIds = await redis.smembers(roomKey);
                // Fetch sessions for each user
                const sessions = await Promise.all(
                    userIds.map(async (id) => {
                        const sessionData = await redis.lrange(
                            `sessions:${id}`,
                            0,
                            -1
                        );
                        return sessionData.map((session) =>
                            JSON.parse(session)
                        );
                    })
                );
                return sessions;
            } else {
                // Get sessions for a specific user
                const sessions = await redis.lrange(sessionListKey, 0, -1);
                return sessions.map((session) => JSON.parse(session));
            }
        } catch (err) {
            console.error("Error in getUserSession:", err);
            throw err;
        }
    },
    deleteOldSessions: function () {
        const ttlInMilliseconds = prefs.readPrefs("socket").timeToLive; 
        const cutoffTime = Date.now() - ttlInMilliseconds; 

        // Fetch all session list keys
        redis
            .keys("sessions:*")
            .then((sessionListKeys) => {
                sessionListKeys.forEach(async (listKey) => {
                    try {
                        // Fetch all sessions for the user
                        const sessions = await redis.lrange(listKey, 0, -1);

                        // Filter and delete old sessions
                        sessions.forEach(async (sessionJson, index) => {
                            const session = JSON.parse(sessionJson);
                            if (session.created < cutoffTime) {
                                // Remove the old session from the list
                                await redis.lrem(listKey, 0, sessionJson);
                                prefs.doLog(
                                    "ioredis - Old session deleted:",
                                    sessionJson
                                );
                            }
                        });
                    } catch (error) {
                        prefs.doLog(
                            "ioredis - Error processing session list",
                            error
                        );
                    }
                });
            })
            .catch((err) => {
                prefs.doLog("ioredis - Error fetching session list keys", err);
            });
    },
    getDbStats: function (callback) {
        // Fetch all room keys
        redis
            .keys("room:*")
            .then((roomKeys) => {
                const statsPromises = roomKeys.map((roomKey) => {
                    return new Promise((resolve, reject) => {
                        // Get the count of sessions/users in each room
                        redis
                            .scard(roomKey)
                            .then((count) => {
                                // Extract room name from the key
                                const roomName = roomKey.split(":")[1];
                                resolve({ room: roomName, counter: count });
                            })
                            .catch((err) => reject(err));
                    });
                });
                // Resolve all promises
                Promise.all(statsPromises)
                    .then((results) => {
                        callback(null, results);
                    })
                    .catch((err) => {
                        callback(err, null);
                    });
            })
            .then((results) => {
                callback(null, results);
            })
            .catch((err) => {
                callback(err, []);
            });
    },
};
