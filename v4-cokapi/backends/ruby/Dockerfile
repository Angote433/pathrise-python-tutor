# Ruby visualizer backend using a custom-compiled version of Ruby (MRI) 2.2

# to build:
# docker build -t="pgbovine/cokapi-ruby:v1" .
#
# to test:
# docker run -t -i --rm --user=netuser --net=none --cap-drop all pgbovine/cokapi-ruby:v1 bash
#
# remember --rm or else stale old containers will be left around!
# use "docker ps -a" to see all containers

# trusty (14.04) packages have been fully retired from Canonical's
# archives (not just relocated to old-releases.ubuntu.com), so this uses
# bionic (18.04) instead -- the last LTS where the 'python' package
# still resolves to Python 2, which golden_test.py requires
FROM ubuntu:18.04
MAINTAINER Philip Guo <philip@pgbovine.net>

# lots of packages required especially to build ruby and to use the compiled version of 'gem'
RUN apt-get update && apt-get install -y \
  python \
  build-essential \
  zlibc \
  zlib1g \
  zlib1g-dev \
  libssl-dev


# Ruby backend: pretty complex setup since we need to compile and
# install a custom Ruby interpreter
#
# run all of this stuff early so that we don't invalidate the cache
RUN mkdir /tmp/ruby
# automatically untars
ADD custom-ruby-interpreter/ruby-2.2.2.tar.gz /tmp/ruby
ADD custom-ruby-interpreter/altered-files /tmp/ruby/ruby-2.2.2
RUN mkdir /tmp/ruby/ruby-2.2.2-custom-OPT/
RUN cd /tmp/ruby/ruby-2.2.2 && ./configure --prefix=/tmp/ruby/ruby-2.2.2-custom-OPT/
# beware takes a long time! so make sure we cache the build
RUN cd /tmp/ruby/ruby-2.2.2 && make && make install
# install custom gem: this old Ruby's ext/openssl doesn't build against
# modern OpenSSL 1.1+, so `gem install` can't talk to rubygems.org over
# HTTPS -- install a pre-fetched .gem file locally instead, which needs
# no network/TLS at all
COPY debug_inspector-1.2.0.gem /tmp/ruby/
RUN /tmp/ruby/ruby-2.2.2-custom-OPT/bin/gem install --local /tmp/ruby/debug_inspector-1.2.0.gem

COPY pg_logger.rb /tmp/ruby/
RUN cd /tmp/ruby && ln -s ruby-2.2.2-custom-OPT/bin/ruby

# To properly run Ruby tests, run as root since it needs to write files
COPY golden_test.py /tmp/ruby/
RUN mkdir /tmp/ruby/tests
ADD tests /tmp/ruby/tests

RUN useradd netuser
