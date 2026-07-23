-- Every process run keeps the substrate structure that was explicitly
-- confirmed when the run began. Template updates never rewrite this snapshot.
ALTER TABLE runs
ADD COLUMN initial_state_hash TEXT REFERENCES state_representations(hash);

ALTER TABLE samples
ADD COLUMN inherited_state_hash TEXT REFERENCES state_representations(hash);

CREATE INDEX runs_initial_state_idx
ON runs(initial_state_hash);

CREATE INDEX samples_inherited_state_idx
ON samples(inherited_state_hash);
