FROM node:18

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .


ENV REACT_APP_API_URL=http://backend.santosh.website


EXPOSE 3000

CMD ["npm", "start"]
