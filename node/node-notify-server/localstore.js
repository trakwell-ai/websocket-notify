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
        const sessionKey = `session:${socketSessionId}`;
        const sessionListKey = `sessions:${userId.toUpperCase()}:${socketRoom.toUpperCase()}`;
        const now = Date.now();
        const ttlInSeconds = prefs.readPrefs("socket").timeToLive / 1000; // convert milliseconds to seconds

        // Start a transaction
        const pipeline = redis.pipeline();

        // Store session data in a list per user and room
        pipeline.rpush(
            sessionListKey,
            JSON.stringify({
                room: socketRoom.toUpperCase(),
                session: socketSessionId,
                created: now,
            })
        );

        // Set TTL on the session list
        pipeline.expire(sessionListKey, ttlInSeconds);

        // Map socket ID to user ID with TTL
        pipeline.set(
            sessionKey,
            JSON.stringify({
                userId: userId.toUpperCase(),
                room: socketRoom.toUpperCase(),
            }),
            "EX",
            ttlInSeconds
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

    // Get all User Sessions from Redis - SIMPLIFIED
    getUserSession: async function (userId, socketRoom) {
        try {
            const sessionListKey = `sessions:${userId.toUpperCase()}:${socketRoom.toUpperCase()}`;
            const ttlInSeconds = prefs.readPrefs("socket").timeToLive / 1000;

            if (
                userId.toUpperCase() === "ALL" &&
                socketRoom.toUpperCase() === "PUBLIC"
            ) {
                // For "ALL" users in "PUBLIC" room, we need to find all matching session lists
                const allSessionKeys = await redis.keys("sessions:*:PUBLIC");

                let allSessions = [];

                // Process each user's sessions
                for (const key of allSessionKeys) {
                    // Refresh TTL on each active key
                    await redis.expire(key, ttlInSeconds);

                    // Get all sessions in this list
                    const sessions = await redis.lrange(key, 0, -1);
                    allSessions = allSessions.concat(
                        sessions.map((s) => JSON.parse(s))
                    );
                }

                return allSessions;
            } else {
                // Get sessions for a specific user
                const sessions = await redis.lrange(sessionListKey, 0, -1);

                // Refresh TTL on active keys
                if (sessions.length > 0) {
                    await redis.expire(sessionListKey, ttlInSeconds);
                }

                return sessions.map((session) => JSON.parse(session));
            }
        } catch (err) {
            console.error("Error in getUserSession:", err);
            throw err;
        }
    },

    // Remove a specific user session - SIMPLIFIED
    removeUserSession: function (userId, socketSessionId, callback) {
        const sessionKey = `session:${socketSessionId}`;

        // Get the session information first
        redis
            .get(sessionKey)
            .then(async (sessionData) => {
                if (!sessionData) {
                    if (callback)
                        callback(null, {
                            removed: false,
                            reason: "Session not found",
                        });
                    return;
                }

                let sessionInfo;
                try {
                    sessionInfo = JSON.parse(sessionData);
                } catch (err) {
                    if (callback) callback(err);
                    return;
                }

                const roomName = sessionInfo.room;
                const sessionListKey = `sessions:${userId.toUpperCase()}:${roomName}`;

                // Start pipeline for atomic operations
                const pipeline = redis.pipeline();

                // Get all sessions for this user in this room
                const sessions = await redis.lrange(sessionListKey, 0, -1);

                // Find and remove the specific session
                let sessionFound = false;
                for (const sessionJson of sessions) {
                    try {
                        const session = JSON.parse(sessionJson);
                        if (session.session === socketSessionId) {
                            pipeline.lrem(sessionListKey, 1, sessionJson);
                            sessionFound = true;
                            break;
                        }
                    } catch (err) {
                        // Skip invalid JSON
                        prefs.doLog(
                            "Invalid session JSON during removal:",
                            sessionJson
                        );
                    }
                }

                // Delete the session key
                pipeline.del(sessionKey);

                // Execute all commands
                await pipeline.exec();

                // If we didn't find the session in the list but deleted the key
                if (!sessionFound) {
                    prefs.doLog(
                        `Session key removed for ${userId} but not found in session list`
                    );
                } else {
                    prefs.doLog(`Session removed for user ${userId}`);
                }

                if (callback) callback(null, { removed: true });
            })
            .catch((err) => {
                prefs.doLog("Error removing session:", err);
                if (callback) callback(err);
            });
    },

    // Delete old sessions - SIMPLIFIED
    deleteOldSessions: function (callback) {
        const ttlInMilliseconds = prefs.readPrefs("socket").timeToLive;
        const cutoffTime = Date.now() - ttlInMilliseconds;

        // Process in two steps:
        // 1. Clean up session lists
        // 2. Clean up orphaned session keys

        // Step 1: Find and process all session lists
        redis
            .keys("sessions:*")
            .then(async (sessionListKeys) => {
                try {
                    let totalRemoved = 0;
                    let totalLists = sessionListKeys.length;

                    for (const listKey of sessionListKeys) {
                        // Get all sessions in this list
                        const sessions = await redis.lrange(listKey, 0, -1);

                        // Identify expired sessions
                        const sessionsToRemove = [];
                        const validSessions = [];

                        for (const sessionJson of sessions) {
                            try {
                                const session = JSON.parse(sessionJson);
                                if (session.created < cutoffTime) {
                                    sessionsToRemove.push({
                                        json: sessionJson,
                                        sessionId: session.session,
                                    });
                                } else {
                                    validSessions.push(sessionJson);
                                }
                            } catch (err) {
                                // Remove invalid JSON
                                sessionsToRemove.push({
                                    json: sessionJson,
                                    sessionId: null,
                                });
                            }
                        }

                        // Skip if nothing to remove
                        if (sessionsToRemove.length === 0) {
                            continue;
                        }

                        totalRemoved += sessionsToRemove.length;

                        // Process removals
                        const pipeline = redis.pipeline();

                        // Remove expired sessions from list
                        for (const item of sessionsToRemove) {
                            pipeline.lrem(listKey, 0, item.json);

                            // Delete corresponding session key
                            if (item.sessionId) {
                                pipeline.del(`session:${item.sessionId}`);
                            }
                        }

                        // If list is now empty, delete it
                        if (validSessions.length === 0) {
                            pipeline.del(listKey);
                        }

                        await pipeline.exec();
                    }

                    // Step 2: Find orphaned session keys
                    const sessionKeys = await redis.keys("session:*");
                    const orphanedCount = 0;

                    for (const sessionKey of sessionKeys) {
                        const sessionData = await redis.get(sessionKey);

                        if (!sessionData) {
                            // Key exists but has no data, delete it
                            await redis.del(sessionKey);
                            orphanedCount++;
                            continue;
                        }

                        try {
                            const sessionInfo = JSON.parse(sessionData);
                            const userId = sessionInfo.userId;
                            const room = sessionInfo.room;

                            if (!userId || !room) {
                                // Invalid data, delete it
                                await redis.del(sessionKey);
                                orphanedCount++;
                                continue;
                            }

                            // Check if the session exists in the appropriate list
                            const listKey = `sessions:${userId}:${room}`;
                            const exists = await redis.exists(listKey);

                            if (!exists) {
                                // If the list doesn't exist, delete the session key
                                await redis.del(sessionKey);
                                orphanedCount++;
                            }
                        } catch (err) {
                            // Invalid JSON, delete the key
                            await redis.del(sessionKey);
                            orphanedCount++;
                        }
                    }

                    prefs.doLog(
                        `Cleanup complete: Removed ${totalRemoved} sessions from ${totalLists} lists and ${orphanedCount} orphaned session keys`
                    );

                    if (callback)
                        callback(
                            {
                                removed: totalRemoved,
                                lists: totalLists,
                                orphaned: orphanedCount,
                            },
                            null
                        );
                } catch (error) {
                    prefs.doLog("Error in deleteOldSessions:", error);
                    if (callback) callback(null, error);
                }
            })
            .catch((err) => {
                prefs.doLog("Error getting session keys:", err);
                if (callback) callback(null, err);
            });
    },

    getDbStats: function (callback) {
        // Simplified stats function that counts sessions by room
        redis
            .keys("sessions:*")
            .then(async (sessionKeys) => {
                try {
                    // Parse room from key format "sessions:{userId}:{roomName}"
                    const roomStats = {};

                    for (const key of sessionKeys) {
                        const parts = key.split(":");
                        if (parts.length >= 3) {
                            const room = parts[2];

                            // Count sessions in this list
                            const count = await redis.llen(key);

                            if (!roomStats[room]) {
                                roomStats[room] = 0;
                            }

                            roomStats[room] += count;
                        }
                    }

                    // Convert to array format expected by existing code
                    const results = Object.entries(roomStats).map(
                        ([room, counter]) => ({
                            room,
                            counter,
                        })
                    );

                    callback(null, results);
                } catch (err) {
                    callback(err, []);
                }
            })
            .catch((err) => {
                callback(err, []);
            });
    },
};
