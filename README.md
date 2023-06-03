# Kyntainer
## An user friendly approach to deploy Kynesys nodes

### Environment

If you need to customize your environment, you can edit env_setup.sh (which is ran each time the container is started) and edit the appropriate variables (for example you can map ports based on your environment without disrupting anything).

### Running, building and managing

For a completely automated building, deployment and naming of the Kyntainer node, run:
	sh deploy.sh

NOTE: The node name (which must be unique between containers on the same machine) is defined in the file called "name" in this directory. Feel free to change it.

If you want to run the scripts manually:

WIP
