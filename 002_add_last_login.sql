-- Migration: Add last_login_at column to track user activity for data retention

ALTER TABLE users 
ADD COLUMN last_login_at TIMESTAMP WITH TIME ZONE;