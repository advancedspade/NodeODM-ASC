const NoTokenRequiredAuth = require("./NoTokenRequiredAuth");
const TokenIpAuth = require("./TokenIpAuth");
const SimpleTokenAuth = require("./SimpleTokenAuth");
const GoogleOAuthAuth = require("./GoogleOAuthAuth");

module.exports = {
    fromConfig: function (config) {
        if (config.oauthEnabled) {
            return new GoogleOAuthAuth(config);
        }
        if (config.token && config.authorizedIps && config.authorizedIps.length) {
            return new TokenIpAuth(config.token, config.authorizedIps);
        } else if (config.token) {
            return new SimpleTokenAuth(config.token);
        } else {
            return new NoTokenRequiredAuth();
        }
    },
};