# Init container for the regtest stack: funds the LND nodes and opens the
# alice<->bob channel once bitcoind + both LND nodes are ready.
#
# Runs bitcoind's entrypoint (bitcoin user) with lncli copied from the lnd
# image so a single container can talk to both bitcoind (bitcoin-cli) and
# LND (lncli).
FROM polarlightning/bitcoind:30.0

# Copy static lncli from the lnd image (same version as lnd-alice/bob).
COPY --from=polarlightning/lnd:0.20.0-beta /opt/lnd/lncli /usr/local/bin/lncli

COPY ./init.sh /init.sh
RUN chmod +x /init.sh

ENTRYPOINT ["/init.sh"]