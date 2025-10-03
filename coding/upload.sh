export REPO_ROOT=./subtensor
export BRANCH=devnet-ready

if [ ! -d "subtensor" ]; then
  git clone https://github.com/opentensor/subtensor $REPO_ROOT
fi

cd subtensor
git checkout $BRANCH
git pull
cd ..

cp .ragignore $REPO_ROOT

node upload.js


