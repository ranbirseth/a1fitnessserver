
$ErrorActionPreference = "Stop"

# Backend configuration
$baseUrl = "http://localhost:5000"
$endpoint = "$baseUrl/api/scanners/events"

# Scanner credentials
$scannerMongoId = "6ade1605cac57bb15ccb145e"
$scannerId = "TEST-SCANNER-BR2-001"
$scannerKey = "f61705607702a06678983078cd0fed72a3fa5d2dd8fbb533"

# Test member registered on the scanner
$userId = "00000262"

# Generate a unique event ID for each test
$deviceEventId = "manual-test-$([guid]::NewGuid().ToString())"

# Build check-in payload
$bodyObject = @{
    events = @(
        @{
            userId        = $userId
            verified      = $true
            eventType     = "fingerprint"
            timestamp     = (Get-Date).ToUniversalTime().ToString("o")
            deviceEventId = $deviceEventId
        }
    )
}

$body = $bodyObject | ConvertTo-Json -Depth 5

Write-Host "`n=== Scanner Check-in Test ===" -ForegroundColor Cyan
Write-Host "Backend:        $baseUrl"
Write-Host "Scanner ID:     $scannerId"
Write-Host "Scanner DB ID:  $scannerMongoId"
Write-Host "Member User ID: $userId"
Write-Host "Event ID:       $deviceEventId"

try {
    Write-Host "`nSending check-in request..." -ForegroundColor Yellow

    $response = Invoke-RestMethod `
        -Method Post `
        -Uri $endpoint `
        -Headers @{
            "x-scanner-id"  = $scannerId
            "x-scanner-key" = $scannerKey
        } `
        -ContentType "application/json" `
        -Body $body `
        -TimeoutSec 30

    Write-Host "`nSUCCESS: Backend returned a response." -ForegroundColor Green
    $response | ConvertTo-Json -Depth 10
}
catch {
    Write-Host "`nFAILED: Check-in request failed." -ForegroundColor Red
    Write-Host "Error: $($_.Exception.Message)"

    if ($_.ErrorDetails.Message) {
        Write-Host "`nBackend response:" -ForegroundColor Yellow
        Write-Host $_.ErrorDetails.Message
    }

    if ($_.Exception.Response) {
        Write-Host "`nHTTP status: $([int]$_.Exception.Response.StatusCode)"
    }
}

Write-Host "`nTest completed. Check the backend logs for authorization events."
