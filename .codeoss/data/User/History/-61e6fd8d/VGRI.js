/**
 * @jest-environment jsdom
 */

import { setupAllForms } from './forms';
import { apiFetch } from './apiUtil';
import { showNotification } from './notifications';

// 1. Mock the imported dependencies
jest.mock('./apiUtil', () => ({
    apiFetch: jest.fn()
}));

jest.mock('./notifications', () => ({
    showNotification: jest.fn()
}));

jest.mock('./mapbox_maps', () => ({
    updateMapMarkers: jest.fn(),
    drawRoute: jest.fn(),
    clearRoute: jest.fn(),
    focusMapMarker: jest.fn()
}));

jest.mock('./results_view', () => ({
    renderResultsList: jest.fn()
}));

describe('Frontend Form Validation (forms.js)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        
        // 2. Set up the necessary HTML structure in JSDOM before each test
        document.body.innerHTML = `
            <form id="register-company-form">
                <input type="checkbox" id="privacy-policy-checkbox" name="privacyPolicy">
                <input type="file" name="thumbnail" id="thumbnail-input">
                <button type="submit">Register</button>
            </form>

            <form id="post-load-form">
                <input type="date" name="pickupDate" id="pickup-date">
                <input type="date" name="deliveryDate" id="delivery-date">
                <button type="submit">Post Load</button>
            </form>

            <form id="find-load-form">
                <input type="text" name="backhaul-origin" id="backhaul-origin" value="NY">
                <input type="text" name="backhaul-destination" id="backhaul-dest" value="LA">
                <button type="submit">Find Loads</button>
            </form>

            <form id="signed-bol-form">
                <input type="hidden" name="loadId" value="123">
                <input type="file" name="signedBolDocument" id="signed-bol-input">
                <button type="submit">Upload</button>
            </form>
        `;

        // Initialize event listeners on the injected HTML
        setupAllForms();
    });

    // Helper function to mock file selection in JSDOM
    const attachMockFile = (inputId, fileName, mimeType, sizeInBytes) => {
        const fileInput = document.getElementById(inputId);
        // Create a mock file
        const file = new File(['dummy content'], fileName, { type: mimeType });
        // Object.defineProperty is needed to overwrite the read-only 'size' property for testing
        Object.defineProperty(file, 'size', { value: sizeInBytes });
        
        // Use DataTransfer to cleanly attach the file to the input element
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        fileInput.files = dataTransfer.files;
    };

    describe('Company Registration Form', () => {
        it('should prevent submission if privacy policy is not checked', () => {
            const form = document.getElementById('register-company-form');
            document.getElementById('privacy-policy-checkbox').checked = false;
            
            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

            expect(showNotification).toHaveBeenCalledWith('You must agree to the Privacy Policy and Terms of Service to register.', 'warning');
            expect(apiFetch).not.toHaveBeenCalled();
        });

        it('should prevent submission if an invalid image format is uploaded', () => {
            const form = document.getElementById('register-company-form');
            document.getElementById('privacy-policy-checkbox').checked = true;
            
            // Attach a PDF instead of an image
            attachMockFile('thumbnail-input', 'test.pdf', 'application/pdf', 1024);
            
            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

            expect(showNotification).toHaveBeenCalledWith('Please upload a valid image file (JPEG, PNG, GIF, or WebP).', 'warning');
            expect(apiFetch).not.toHaveBeenCalled();
        });

        it('should submit successfully if validations pass', async () => {
            const form = document.getElementById('register-company-form');
            document.getElementById('privacy-policy-checkbox').checked = true;
            attachMockFile('thumbnail-input', 'test.jpg', 'image/jpeg', 1024);
            
            apiFetch.mockResolvedValueOnce({ message: 'Success' });
            
            // Dispatch and wait for async handlers to finish
            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            await new Promise(process.nextTick); 

            expect(apiFetch).toHaveBeenCalled();
            expect(showNotification).toHaveBeenCalledWith('Company registered successfully!', 'success');
        });
    });

    describe('Post Load Form', () => {
        it('should prevent submission if delivery date is before pickup date', () => {
            const form = document.getElementById('post-load-form');
            document.getElementById('pickup-date').value = '2025-05-10';
            document.getElementById('delivery-date').value = '2025-05-01'; // Before pickup
            
            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

            expect(showNotification).toHaveBeenCalledWith('Delivery date cannot be before pickup date.', 'warning');
            expect(apiFetch).not.toHaveBeenCalled();
        });
    });

    describe('Find Load Form', () => {
        it('should prevent search if origin or destination is missing', () => {
            const form = document.getElementById('find-load-form');
            document.getElementById('backhaul-origin').value = ''; // Empty origin
            document.getElementById('backhaul-dest').value = 'LA';
            
            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

            expect(showNotification).toHaveBeenCalledWith('Please provide both an origin and a destination for your back-haul route.', 'warning');
            expect(apiFetch).not.toHaveBeenCalled();
        });
    });

    describe('Signed BOL Form', () => {
        it('should prevent submission if no file is selected', () => {
            const form = document.getElementById('signed-bol-form');
            
            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

            expect(showNotification).toHaveBeenCalledWith('Please select a file to upload.', 'warning');
            expect(apiFetch).not.toHaveBeenCalled();
        });

        it('should prevent submission if the file is too large (>10MB)', () => {
            const form = document.getElementById('signed-bol-form');
            // 11MB file size
            attachMockFile('signed-bol-input', 'huge.pdf', 'application/pdf', 11 * 1024 * 1024);
            
            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

            expect(showNotification).toHaveBeenCalledWith('File is too large. Maximum size is 10MB.', 'warning');
            expect(apiFetch).not.toHaveBeenCalled();
        });

        it('should submit successfully for valid PDF files', async () => {
            const form = document.getElementById('signed-bol-form');
            attachMockFile('signed-bol-input', 'valid.pdf', 'application/pdf', 1024);
            
            apiFetch.mockResolvedValueOnce({ message: 'Uploaded!' });
            
            form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
            await new Promise(process.nextTick); 

            expect(apiFetch).toHaveBeenCalled();
            expect(showNotification).toHaveBeenCalledWith('Uploaded!', 'success');
        });
    });
});