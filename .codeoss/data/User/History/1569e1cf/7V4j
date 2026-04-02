# Stage 1: Build Stage
# Use a Node.js version that matches your development environment.
# Using alpine for a smaller image size.
FROM node:18-alpine AS builder

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (or yarn.lock) to leverage Docker cache
COPY package*.json ./

# Install ALL dependencies (including devDependencies like TypeScript)
RUN npm install

# Copy the rest of your application's source code
COPY . .

# Run the TypeScript compiler
RUN npm run build

# Prune dev dependencies for a smaller production image
RUN npm prune --production

# Stage 2: Production Stage
# Use a lightweight, secure Node.js image for the final container
FROM node:18-alpine

# Set NODE_ENV to production for security and performance
ENV NODE_ENV=production

# Install tini, a lightweight init system that handles signal forwarding
# and zombie reaping, crucial for graceful shutdowns in containers.
RUN apk add --no-cache tini

WORKDIR /usr/src/app

# The official node image creates a 'node' user. We'll copy files as root first.
# Copy only the production dependencies and package.json from the builder stage
COPY --from=builder /usr/src/app/node_modules ./node_modules

# Copy only the built output from the builder stage (assuming it outputs to 'dist')
COPY --from=builder /usr/src/app/dist ./dist

# Change ownership of all application files to the non-root 'node' user
RUN chown -R node:node .

# Switch to the non-root user to avoid running as root
USER node

# Render injects the PORT environment variable (defaults to 10000). Your app must listen on this port.
EXPOSE 10000

# Use tini as the entrypoint to properly handle signals and reap zombie processes
ENTRYPOINT ["/sbin/tini", "--"]

# The command to start your application, executed by tini.
CMD [ "node", "dist/index.js" ]