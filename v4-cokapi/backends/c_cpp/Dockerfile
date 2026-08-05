# to build:
# docker build -t="pgbovine/opt-cpp-backend:v1" .
#
# to test:
# docker run -t -i --rm --user=netuser --net=none --cap-drop all pgbovine/opt-cpp-backend:v1 bash
#
# remember --rm or else stale old containers will be left around!
# use "docker ps -a" to see all containers

# trusty (14.04) packages have been fully retired from Canonical's
# archives (not just relocated to old-releases.ubuntu.com), so this uses
# bionic (18.04) instead -- the last LTS where the 'python' package
# still resolves to Python 2, which run_cpp_backend.py requires
FROM ubuntu:18.04
MAINTAINER Philip Guo <philip@pgbovine.net>

# to get gcc and g++, Valgrind needs libc6-dbg apparently
RUN apt-get update && apt-get install -y \
  build-essential \
  autotools-dev \
  automake \
  libc6-dbg \
  python

RUN mkdir /tmp/opt-cpp-backend
ADD . /tmp/opt-cpp-backend

# we need to compile Valgrind from scratch within the container (hence
# 'make clean' first) to make it work from within the container, ergh
RUN cd /tmp/opt-cpp-backend/valgrind-3.11.0 && (make clean || true) && ./autogen.sh && ./configure --prefix=`pwd`/inst && make && make install

RUN useradd netuser

RUN cd /tmp/ && find . | xargs chown netuser
