#!/bin/bash
CURR=$(dirname "${BASH_SOURCE[0]}")

out=$CURR/docs/user-guide/cli-options.md
echo "# All Command-Line Options" > $out
echo "" >> $out
echo "The Crawlertrix Docker image currently accepts the following parameters, broken down by entrypoint:" >> $out
echo "" >> $out
echo "## crawler" >> $out
echo "" >> $out
echo '```' >> $out
#node $CURR/../dist/main.js --help >> $out
docker run webrecorder/crawlertrix crawl --help | tail -n +3 >> $out
echo '```' >> $out
echo "" >> $out
echo "## create-login-profile" >> $out
echo "" >> $out
echo '```' >> $out
docker run webrecorder/crawlertrix create-login-profile --help | tail -n +3 >> $out
echo '```' >> $out
