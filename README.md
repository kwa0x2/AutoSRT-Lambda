# AutoSRT-Lambda
lambda func for autosrt project

increase the memory to 2048mb and set the timeout to 5 minutes for better performance

for 11 min and 15mb mp3
```
START RequestId: a446ea73-29e7-48ae-9a5e-fa2430ff02ff Version: $LATEST
2024-12-19T16:22:07.302Z	a446ea73-29e7-48ae-9a5e-fa2430ff02ff	INFO	s3-fetch: 381.227ms
2024-12-19T16:22:14.397Z	a446ea73-29e7-48ae-9a5e-fa2430ff02ff	INFO	whisper-api: 7.094s
2024-12-19T16:22:14.401Z	a446ea73-29e7-48ae-9a5e-fa2430ff02ff	INFO	srt-generation: 3.838ms
2024-12-19T16:22:14.457Z	a446ea73-29e7-48ae-9a5e-fa2430ff02ff	INFO	s3-upload: 55.169ms
2024-12-19T16:22:14.457Z	a446ea73-29e7-48ae-9a5e-fa2430ff02ff	INFO	total-execution: 7.536s
END RequestId: a446ea73-29e7-48ae-9a5e-fa2430ff02ff
REPORT RequestId: a446ea73-29e7-48ae-9a5e-fa2430ff02ff	Duration: 7541.68 ms	Billed Duration: 7542 ms	Memory Size: 2048 MB	Max Memory Used: 179 MB	Init Duration: 893.35 ms
```
