FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm i -D typescript @types/express @types/node
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc && npm prune --omit=dev
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/server.js"]
