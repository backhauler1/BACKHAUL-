const nodemailer = require('nodemailer');
const sendEmail = require('./email');

jest.mock('nodemailer');

describe('Email Utility (email.js)', () => {
    let mockSendMail;

    beforeEach(() => {
        jest.clearAllMocks();
        
        // Setup the mock structure that `nodemailer.createTransport` returns
        mockSendMail = jest.fn().mockResolvedValue(true);
        nodemailer.createTransport.mockReturnValue({
            sendMail: mockSendMail
        });
        
        // Set dummy env vars for test predictability
        process.env.EMAIL_HOST = 'smtp.test.com';
        process.env.EMAIL_PORT = '587';
        process.env.EMAIL_USER = 'user';
        process.env.EMAIL_PASS = 'pass';
        process.env.EMAIL_FROM = 'noreply@test.com';
    });

    it('should construct the transport and call sendMail with the right options', async () => {
        const options = {
            to: 'customer@test.com',
            subject: 'Test Subject',
            text: 'Hello World',
            html: '<p>Hello World</p>'
        };

        await sendEmail(options);

        expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
        expect(mockSendMail).toHaveBeenCalledWith({
            from: 'noreply@test.com',
            ...options
        });
    });
});