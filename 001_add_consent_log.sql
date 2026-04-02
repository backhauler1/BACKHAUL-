-- Migration: Add JSONB column for Terms of Service and Privacy Policy consent logging

ALTER TABLE users 
ADD COLUMN consent_log JSONB;