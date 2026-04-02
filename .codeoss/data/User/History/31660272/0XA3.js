describe('Freight App End-to-End Flow', () => {
  const testEmail = `testuser_${Date.now()}@example.com`;
  const testPassword = 'SecurePassword123';

  it('should register a new user successfully', () => {
    cy.visit('/register'); // Adjust this to your actual register URL
    
    // Fill out the registration form
    cy.get('input[name="name"]').type('E2E Test User');
    cy.get('input[name="email"]').type(testEmail);
    cy.get('input[name="password"]').type(testPassword);
    
    // If you have a privacy policy checkbox (as seen in companies.js), check it
    cy.get('input[name="privacyPolicy"]').check();
    
    cy.get('button[type="submit"]').click();

    // Verify the success notification appears
    cy.get('.notification-success').should('contain', 'User registered successfully');
  });

  it('should log in and post a new load', () => {
    // Note: In a real test, you might want to programmatically log in using cy.request
    // to save time, but here we test the UI.
    cy.visit('/login');
    cy.get('input[name="email"]').type(testEmail);
    cy.get('input[name="password"]').type(testPassword);
    cy.get('button[type="submit"]').click();

    // Navigate to the "My Posted Loads" page
    cy.visit('/my-loads'); // Adjust this to your actual routing path
    
    // Open the form and post a load
    cy.get('#toggle-post-load-btn').click();
    cy.get('input[name="title"]').type('E2E Heavy Machinery');
    cy.get('input[name="pickupAddress"]').type('Chicago, IL');
    cy.get('input[name="deliveryAddress"]').type('Detroit, MI');
    cy.get('#inline-post-load-form button[type="submit"]').click();

    // Verify the new load appears in the DOM
    cy.get('.loads-grid').should('contain', 'E2E Heavy Machinery');
    cy.get('.notification-success').should('contain', 'Load posted successfully!');
  });
});
