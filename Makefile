SRC_DIR = compiler/source
LIB_DIR = compiler/build
SRC     = $(wildcard $(SRC_DIR)/*.origami $(SRC_DIR)/**/*.origami)
TGT     = ${SRC:$(SRC_DIR)/%.origami=$(LIB_DIR)/%.js}

$(LIB_DIR)/%.js: $(SRC_DIR)/%.origami
	mkdir -p $(dir $@)
	./bootstrap/origami.js compile $< > $@

build: $(TGT)

test: build
	npm test

test-bootstrap:
	TEST_ONLY=bootstrap npm test

test-new: build
	TEST_ONLY=new npm test

benchmark:
	node --expose_gc test/benchmark/run.js

benchmark-time:
	node --expose_gc test/benchmark/run.js time

clean:
	rm -r $(LIB_DIR)