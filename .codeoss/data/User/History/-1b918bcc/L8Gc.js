const i18next = require('i18next');
const middleware = require('i18next-http-middleware');

i18next.use(middleware.LanguageDetector).init({
    fallbackLng: 'en',
    preload: ['en', 'es'],
    resources: {
        en: {
            translation: {
                auth: {
                    emailRequired: "Please provide an email address.",
                    resetEmailSent: "If an account with that email exists, we have sent a password reset link.",
                    serverError: "There was an error processing your request.",
                    email: {
                        subject: "Password Reset Request",
                        text: "Hi {{name}},\n\nYou requested a password reset. Please go to this link to reset your password:\n\n{{resetUrl}}\n\nThis link will expire in 1 hour.\nIf you did not request this, please ignore this email.",
                        html: `
                            <div style="font-family: sans-serif; line-height: 1.6;">
                                <h2>Password Reset</h2>
                                <p>Hi {{name}},</p>
                                <p>You requested a password reset. Click the button below to choose a new password:</p>
                                <a href="{{resetUrl}}" style="display: inline-block; padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px;">Reset Password</a>
                                <p>Or copy and paste this link into your browser:</p>
                                <p><a href="{{resetUrl}}">{{resetUrl}}</a></p>
                                <p>This link will expire in 1 hour. If you did not request this, please ignore this email.</p>
                            </div>
                        `
                    }
                }
            }
        },
        es: {
            translation: {
                auth: {
                    emailRequired: "Por favor, introduzca una dirección de correo electrónico.",
                    resetEmailSent: "Si existe una cuenta con ese correo, le hemos enviado un enlace para restablecer la contraseña.",
                    serverError: "Hubo un error al procesar su solicitud.",
                    email: {
                        subject: "Solicitud de Restablecimiento de Contraseña",
                        text: "Hola {{name}},\n\nSolicitó restablecer su contraseña. Vaya a este enlace para restablecerla:\n\n{{resetUrl}}\n\nEste enlace caducará en 1 hora.\nSi no solicitó esto, ignore este correo electrónico.",
                        html: "<div style='font-family: sans-serif; line-height: 1.6;'><h2>Restablecimiento de Contraseña</h2><p>Hola {{name}},</p><p>Haga clic a continuación para elegir una nueva contraseña:</p><a href='{{resetUrl}}' style='display: inline-block; padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px;'>Restablecer Contraseña</a><p>O copie este enlace: <a href='{{resetUrl}}'>{{resetUrl}}</a></p></div>"
                    }
                }
            }
        }
    }
});

module.exports = { i18next, middleware };