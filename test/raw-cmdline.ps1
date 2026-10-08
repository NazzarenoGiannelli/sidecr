# Test fixture (test/os.test.ts): reports the raw command line this process was started with, and how many arguments it was split into.
# It stands in for explorer.exe, so the quoting of the command line can be checked without starting Explorer.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[pscustomobject]@{ raw = [Environment]::CommandLine; count = $args.Count; args = @($args) } | ConvertTo-Json -Compress
