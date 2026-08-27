# Organizer questions

## Metric naming conflict

The supplied Starter Kit is the executable contract used for development. Its
`evaluate.py` computes `GAUC` and `nDCG@5`, and defines `primary` as their
arithmetic mean. This conflicts with challenge prose that names `NDCG@10` and
`Recall@50`.

Before freezing the final scored-run configuration, please confirm in writing:

1. Is the submitted KuaiRand-Pure benchmark scored with `GAUC` and `nDCG@5`?
2. Is the primary score exactly the arithmetic mean implemented by the supplied
   `evaluate.py`?
3. Does the supplied evaluator take precedence over conflicting prose?

Until confirmed, `configs/benchmarks/kuairand_pure.yaml` records the behavior of
the supplied executable evaluator and the final competition configuration
remains a release blocker.

## Test-label boundary

The downloaded public reference archive contains `long_view` for its local test
date range, and the supplied `submit.py` permits `--score --split test`. Please
confirm which separately supplied final-test artifact is private. The agent must
never receive labels for that private artifact; the public reference labels are
used only by the baseline reproduction test.
