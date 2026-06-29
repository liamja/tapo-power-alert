# Paste into Forge → Site → Deployments → Deploy Script
#
# Zero-downtime releases: https://forge.laravel.com/docs/sites/deployments
# .env is linked automatically by Forge from $FORGE_SITE_ROOT/.env
# wg0.conf lives at $FORGE_SITE_ROOT/wg0.conf (same level as .env)
#
# Do not symlink wg0.conf into the release — Docker bind mounts break on symlinks.

$CREATE_RELEASE()

cd $FORGE_RELEASE_DIRECTORY

if [ ! -f "$FORGE_SITE_ROOT/wg0.conf" ]; then
    echo "Missing $FORGE_SITE_ROOT/wg0.conf — upload it before deploying."
    exit 1
fi

$ACTIVATE_RELEASE()

cd $FORGE_SITE_PATH

export WIREGUARD_CONFIG_PATH=$FORGE_SITE_ROOT/wg0.conf

docker compose -f compose.server.yml build --pull
docker compose -f compose.server.yml up -d --remove-orphans

docker image prune -f
