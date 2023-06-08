mkdir diagrams
for f in $(find . -name '*.js'); do
    if [[ $f != *"node_modules"* ]]; then
        js2flowchart $f;
		mv $f.svg diagrams/
    fi;
done
