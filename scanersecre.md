PS C:\Users\ranbi\OneDrive\Desktop\Documents\a1fitnesslivecloud> $body = @{ name = "Test Scanner BR2"; deviceId = "TEST-SCANNER-BR2-001"; branchCode = "BR2" } | ConvertTo-Json -Depth 3
>> $result = Invoke-RestMethod -Method Post -Uri "http://localhost:5001/api/scanners" -Headers @{ Authorization = "Bearer $($response.data.accessToken)" } -ContentType "application/json" -Body $body
>> if ($result.success -and $result.data) { Write-Host "SCANNER_ID: $($result.data._id)"; Write-Host "API_KEY: $($result.data.apiKey)"; Write-Warning "SAVE THE API KEY NOW — it will not be shown again!" } else { Write-Error "Creation failed: $($result.message)" }
SCANNER_ID: 6ade1605cac57bb15ccb145e
API_KEY: f61705607702a06678983078cd0fed72a3fa5d2dd8fbb533
WARNING: SAVE THE API KEY NOW — it will not be shown again!
PS C:\Users\ranbi\OneDrive\Desktop\Documents\a1fitnesslivecloud> 