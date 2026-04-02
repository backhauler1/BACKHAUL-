-- Migration: Add deletion_warning_sent to prevent spamming inactivity warnings

ALTER TABLE users 
ADD COLUMN deletion_warning_sent BOOLEAN DEFAULT false;
