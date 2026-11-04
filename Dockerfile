FROM node:20-slim
WORKDIR /app

# Dependencies first, so a code change does not reinstall them.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# The base image ships a `node` user. Running as root inside the container
# means a remote-code bug in a dependency owns the filesystem rather than one
# unprivileged account.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/index.js"]
