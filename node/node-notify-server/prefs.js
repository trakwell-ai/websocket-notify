// prefs.js
require("dotenv").config();
// Note: dotenv will NOT override existing environment variables,
// so machine/server variables will always take priority

module.exports = {
    readPrefs: function (pType) {
        if (pType == "server") {
            return {
                ip: process.env.SERVER_IP || "0.0.0.0",
                port: process.env.SERVER_PORT || "80",
                authUser: process.env.SERVER_AUTH_USER || "",
                authPwd: process.env.SERVER_AUTH_PWD || "",
                sslKeyPath: process.env.SERVER_SSL_KEY_PATH || "",
                sslCertPath: process.env.SERVER_SSL_CERT_PATH || "",
                logging: process.env.SERVER_LOGGING !== "false", // default to true if not specified
                redisHost: process.env.SERVER_REDIS_HOST || "localhost",
                redisPort: parseInt(process.env.SERVER_REDIS_PORT || "6379"),
            };
        } else if (pType == "socket") {
            return {
                private: process.env.SOCKET_PRIVATE !== "false", // default to true if not specified
                public: process.env.SOCKET_PUBLIC !== "false", // default to true if not specified
                authToken: process.env.SOCKET_AUTH_TOKEN || "please-change-me",
                timeToLive: parseInt(
                    process.env.SOCKET_TIME_TO_LIVE || "86400000"
                ),
            };
        }
    },
    // central logging function
    doLog: function (pMsg, pObj1, pObj2) {
        var serverPrefs = module.exports.readPrefs("server");
        var logging = serverPrefs.logging;
        if (logging) {
            if (pMsg && pObj1 && pObj2) {
                console.log(pMsg, pObj1, pObj2);
            } else if (pMsg && pObj1) {
                console.log(pMsg, pObj1);
            } else if (pMsg) {
                console.log(pMsg);
            }
        }
    },
};
