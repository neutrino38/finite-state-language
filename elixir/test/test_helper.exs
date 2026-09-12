# The engine logs every transition at :debug and every outcome at :info, which is
# what an operator watching a run wants and what a test run does not: a green
# suite would scroll past. Raised to :warning so anything the suite provokes on
# purpose — a failed machine, a deadline — still shows.
Logger.configure(level: :warning)

ExUnit.start()
