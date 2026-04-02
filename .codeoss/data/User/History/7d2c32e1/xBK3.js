const { defineConfig } = require("cypress");

module.exports = defineConfig({
  e2e: {
    baseUrl: 'http://localhost:3000', // Adjust this to match your local dev port
    setupNodeEvents(on, config) {
      // implement node event listeners here
    },
  },
});