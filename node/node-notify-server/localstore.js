// localstore.js
const Redis = require("ioredis");
const prefs = require("./prefs");
const redis = new Redis({
    host: prefs.readPrefs("server").redisHost,
    port: prefs.readPrefs("server").redisPort,
    // Add connection pool optimization
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    keepAlive: 10000, 
});

// Key for tracking active sessions to avoid expensive pattern matching
const ACTIVE_SESSIONS_KEY = "active:sessions";
const ACTIVE_SESSION_LISTS_KEY = "active:sessionlists";

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

    // Save Client Session in Redis - OPTIMIZED to track active keys
    saveUserSession: function (userId, socketRoom, socketSessionId, callback) {
        const sessionKey = `session:${socketSessionId}`;
        const sessionListKey = `sessions:${userId.toUpperCase()}:${socketRoom.toUpperCase()}`;
        const now = Date.now();
        const ttlInSeconds = prefs.readPrefs("socket").timeToLive / 1000; // convert milliseconds to seconds

        // Start transaction
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

        // Add to active keys tracking sets with TTL
        pipeline.sadd(ACTIVE_SESSIONS_KEY, sessionKey);
        pipeline.expire(ACTIVE_SESSIONS_KEY, ttlInSeconds);

        pipeline.sadd(ACTIVE_SESSION_LISTS_KEY, sessionListKey);
        pipeline.expire(ACTIVE_SESSION_LISTS_KEY, ttlInSeconds);

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

    // Get all User Sessions from Redis - OPTIMIZED 
    getUserSession: async function (userId, socketRoom) {
        try {
            const sessionListKey = `sessions:${userId.toUpperCase()}:${socketRoom.toUpperCase()}`;
            const ttlInSeconds = prefs.readPrefs("socket").timeToLive / 1000;

            if (
                userId.toUpperCase() === "ALL" &&
                socketRoom.toUpperCase() === "PUBLIC"
            ) {
                // For "ALL" users in "PUBLIC" room, use the tracked active lists
                let allSessionLists;

                // Check if we have active session tracking
                const trackingExists = await redis.exists(
                    ACTIVE_SESSION_LISTS_KEY
                );

                if (trackingExists) {
                    // Get sessions lists from tracking set
                    allSessionLists = await redis.smembers(
                        ACTIVE_SESSION_LISTS_KEY
                    );
                    // Filter to only include PUBLIC room keys
                    allSessionLists = allSessionLists.filter((key) =>
                        key.endsWith(":PUBLIC")
                    );
                } else {
                    // Fallback to scan if tracking doesn't exist yet
                    // SCAN is much more efficient than KEYS for large datasets
                    allSessionLists = [];
                    let cursor = "0";
                    do {
                        const reply = await redis.scan(
                            cursor,
                            "MATCH",
                            "sessions:*:PUBLIC",
                            "COUNT",
                            100
                        );
                        cursor = reply[0];
                        allSessionLists = allSessionLists.concat(reply[1]);
                    } while (cursor !== "0");

                    // Populate the tracking set for future use
                    if (allSessionLists.length > 0) {
                        await redis.sadd(
                            ACTIVE_SESSION_LISTS_KEY,
                            ...allSessionLists
                        );
                        await redis.expire(
                            ACTIVE_SESSION_LISTS_KEY,
                            ttlInSeconds
                        );
                    }
                }

                let allSessions = [];

                // Process each user's sessions
                for (const key of allSessionLists) {
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

                    // Make sure this key is in our tracking set
                    await redis.sadd(ACTIVE_SESSION_LISTS_KEY, sessionListKey);
                    await redis.expire(ACTIVE_SESSION_LISTS_KEY, ttlInSeconds);
                }

                return sessions.map((session) => JSON.parse(session));
            }
        } catch (err) {
            console.error("Error in getUserSession:", err);
            throw err;
        }
    },

    // Remove a specific user session - OPTIMIZED
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

                // Delete the session key and remove from tracking
                pipeline.del(sessionKey);
                pipeline.srem(ACTIVE_SESSIONS_KEY, sessionKey);

                // If list is now empty, remove from tracking
                if (sessions.length <= 1 && sessionFound) {
                    pipeline.srem(ACTIVE_SESSION_LISTS_KEY, sessionListKey);
                }

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

    // Delete old sessions - OPTIMIZED 
    deleteOldSessions: function (callback) {
        const ttlInMilliseconds = prefs.readPrefs("socket").timeToLive;
        const cutoffTime = Date.now() - ttlInMilliseconds;

        // Process session cleanup using our tracking lists
        Promise.all([
            redis.exists(ACTIVE_SESSIONS_KEY),
            redis.exists(ACTIVE_SESSION_LISTS_KEY),
        ])
            .then(async ([sessionsExist, listsExist]) => {
                try {
                    const pipeline = redis.pipeline();
                    let totalRemoved = 0;
                    let totalLists = 0;

                    // Process session lists
                    if (listsExist) {
                        // Get from tracking set instead of keys pattern matching
                        const sessionListKeys = await redis.smembers(
                            ACTIVE_SESSION_LISTS_KEY
                        );
                        totalLists = sessionListKeys.length;

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
                            for (const item of sessionsToRemove) {
                                pipeline.lrem(listKey, 0, item.json);

                                // Delete corresponding session key and remove from tracking
                                if (item.sessionId) {
                                    const sessionKey = `session:${item.sessionId}`;
                                    pipeline.del(sessionKey);
                                    pipeline.srem(
                                        ACTIVE_SESSIONS_KEY,
                                        sessionKey
                                    );
                                }
                            }

                            // If list is now empty, delete it and remove from tracking
                            if (validSessions.length === 0) {
                                pipeline.del(listKey);
                                pipeline.srem(
                                    ACTIVE_SESSION_LISTS_KEY,
                                    listKey
                                );
                            }
                        }
                    }

                    // Find orphaned session keys by comparing with tracking set
                    if (sessionsExist) {
                        // Get all tracked session keys
                        const trackedSessionKeys = await redis.smembers(
                            ACTIVE_SESSIONS_KEY
                        );

                        // Check each one to make sure it still exists
                        for (const sessionKey of trackedSessionKeys) {
                            const exists = await redis.exists(sessionKey);
                            if (!exists) {
                                // Remove from tracking set if key doesn't exist
                                pipeline.srem(ACTIVE_SESSIONS_KEY, sessionKey);
                            }
                        }
                    }

                    // Execute pipeline if there are commands to process
                    const results = await pipeline.exec();

                    prefs.doLog(
                        `Cleanup complete: Removed ${totalRemoved} sessions from ${totalLists} lists`
                    );

                    if (callback)
                        callback(
                            {
                                removed: totalRemoved,
                                lists: totalLists,
                            },
                            null
                        );
                } catch (error) {
                    prefs.doLog("Error in deleteOldSessions:", error);
                    if (callback) callback(null, error);
                }
            })
            .catch((err) => {
                prefs.doLog("Error checking tracking sets:", err);
                if (callback) callback(null, err);
            });
    },

    // Initialize tracking sets for existing keys - call this once during startup
    initializeTrackingSets: async function () {
        try {
            // Only initialize if tracking sets don't exist
            const [sessionsExist, listsExist] = await Promise.all([
                redis.exists(ACTIVE_SESSIONS_KEY),
                redis.exists(ACTIVE_SESSION_LISTS_KEY),
            ]);

            if (!sessionsExist || !listsExist) {
                prefs.doLog("Initializing Redis key tracking sets...");

                // Use SCAN to find all session keys (more efficient than KEYS)
                const sessionKeys = [];
                const sessionListKeys = [];
                let cursor = "0";

                // Scan for session keys
                do {
                    const reply = await redis.scan(
                        cursor,
                        "MATCH",
                        "session:*",
                        "COUNT",
                        100
                    );
                    cursor = reply[0];
                    sessionKeys.push(...reply[1]);
                } while (cursor !== "0");

                // Scan for session list keys
                cursor = "0";
                do {
                    const reply = await redis.scan(
                        cursor,
                        "MATCH",
                        "sessions:*",
                        "COUNT",
                        100
                    );
                    cursor = reply[0];
                    sessionListKeys.push(...reply[1]);
                } while (cursor !== "0");

                const ttlInSeconds =
                    prefs.readPrefs("socket").timeToLive / 1000;
                const pipeline = redis.pipeline();

                // Add keys to tracking sets and ensure TTL
                if (sessionKeys.length > 0) {
                    pipeline.sadd(ACTIVE_SESSIONS_KEY, ...sessionKeys);
                    pipeline.expire(ACTIVE_SESSIONS_KEY, ttlInSeconds);
                }

                if (sessionListKeys.length > 0) {
                    pipeline.sadd(ACTIVE_SESSION_LISTS_KEY, ...sessionListKeys);
                    pipeline.expire(ACTIVE_SESSION_LISTS_KEY, ttlInSeconds);
                }

                await pipeline.exec();

                prefs.doLog(
                    `Initialized tracking for ${sessionKeys.length} session keys and ${sessionListKeys.length} session lists`
                );
            }
        } catch (err) {
            prefs.doLog("Error initializing tracking sets:", err);
        }
    },

    getDbStats: function (callback) {
        // Optimized stats function that uses tracking set instead of pattern matching
        redis
            .exists(ACTIVE_SESSION_LISTS_KEY)
            .then(async (exists) => {
                try {
                    const roomStats = {};

                    if (exists) {
                        // Get session lists from the tracking set
                        const sessionListKeys = await redis.smembers(
                            ACTIVE_SESSION_LISTS_KEY
                        );

                        for (const key of sessionListKeys) {
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
                    } else {
                        // Fallback to scan if tracking doesn't exist
                        let cursor = "0";
                        do {
                            const reply = await redis.scan(
                                cursor,
                                "MATCH",
                                "sessions:*",
                                "COUNT",
                                100
                            );
                            cursor = reply[0];

                            for (const key of reply[1]) {
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
                        } while (cursor !== "0");
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
