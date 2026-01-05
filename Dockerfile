FROM opendronemap/odm:latest
LABEL maintainer="Piero Toffanin <pt@masseranolabs.com>"

EXPOSE 3000

USER root

# Install Node.js 20.x (LTS) using NodeSource
RUN apt-get update && apt-get install -y curl gpg-agent ca-certificates gnupg && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    apt-get install -y nodejs unzip p7zip-full && \
    npm install -g nodemon && \
    ln -sf /code/SuperBuild/install/bin/untwine /usr/bin/untwine && \
    ln -sf /code/SuperBuild/install/bin/entwine /usr/bin/entwine && \
    ln -sf /code/SuperBuild/install/bin/pdal /usr/bin/pdal && \
    apt-get clean && rm -rf /var/lib/apt/lists/*


RUN mkdir /var/www

WORKDIR "/var/www"
COPY . /var/www

RUN npm install --production && mkdir -p tmp

ENTRYPOINT ["/usr/bin/node", "/var/www/index.js"]
