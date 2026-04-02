/**
 * Express middleware to validate that the user has agreed to the 
 * Terms of Service and Privacy Policy during registration.
 */
function requireConsent(req, res, next) {
    const { privacyPolicy } = req.body;

    // Check if the boolean flag is present and truthy
    if (privacyPolicy !== true && privacyPolicy !== 'true' && privacyPolicy !== 'on') {
        return res.status(400).json({
            error: 'Consent Required',
            message: 'You must agree to the Privacy Policy and Terms of Service to register.'
        });
    }

    // Prepare consent log metadata to be saved in the database
    // This provides a legal audit trail of exactly when and from where they agreed.
    req.consentLog = {
        agreedAt: new Date().toISOString(),
        ipAddress: req.ip || req.connection.remoteAddress,
        userAgent: req.get('User-Agent')
    };

    next();
}

module.exports = requireConsent;
