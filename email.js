const nodemailer = require('nodemailer');

/**
 * Sends an email using nodemailer.
 * @param {Object} options - The email options.
 * @param {string} options.to - Recipient's email address.
 * @param {string} options.subject - Email subject.
 * @param {string} options.text - Plain text body of the email.
 * @param {string} [options.html] - HTML body of the email (optional).
 */
const sendEmail = async (options) => {
    // 1. Create a transporter object using SMTP transport
    //    This configuration is read from your .env file.
    const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: process.env.EMAIL_PORT,
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
        },
    });

    // 2. Define the email options
    const mailOptions = {
        from: process.env.EMAIL_FROM,
        to: options.to,
        subject: options.subject,
        text: options.text,
        html: options.html,
    };

    // 3. Actually send the email
    await transporter.sendMail(mailOptions);
};

module.exports = sendEmail;