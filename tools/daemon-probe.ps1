param(
  [int]$Port = 43117
)

$base = "http://127.0.0.1:$Port/"

Write-Output "--- GET / as browser (Accept: text/html) ---"
try {
  $r = Invoke-WebRequest -Uri $base -Headers @{ Accept = 'text/html' } -UseBasicParsing
  "{0} {1}" -f $r.StatusCode, $r.StatusDescription
  "Content-Type: {0}" -f $r.Headers.'Content-Type'
} catch {
  "(daemon not running on $Port) or error: $($_.Exception.Message)"
}

Write-Output "--- GET / as API (Accept: application/json) ---"
$r = $null
try {
  $r = Invoke-WebRequest -Uri $base -Headers @{ Accept = 'application/json' } -UseBasicParsing
  "{0} {1}" -f $r.StatusCode, $r.StatusDescription
  "Content-Type: {0}" -f $r.Headers.'Content-Type'

  # Parse JSON explicitly so HTML error pages don't masquerade as success.
  $json = $r.Content | ConvertFrom-Json -ErrorAction Stop
  $json
} catch {
  "API call failed. Raw response (if any):"
  try { $r.Content } catch { "(no response body)" }
  "Error: $($_.Exception.Message)"
}
