# AutoSRT-Lambda
lambda func for autosrt project

increase the memory to 2048mb and set the timeout to 5 minutes for better performance

[FFmpeg Layer](https://serverlessrepo.aws.amazon.com/applications/us-east-1/145266761615/ffmpeg-lambda-layer)

for 1 min
```
START RequestId: 7067c9e0-ff74-4bdf-a227-ec957638b13d Version: $LATEST
2024-12-23T10:52:59.119Z	7067c9e0-ff74-4bdf-a227-ec957638b13d	INFO	s3-fetch: 136.693ms
2024-12-23T10:53:00.857Z	7067c9e0-ff74-4bdf-a227-ec957638b13d	INFO	Converted file size: 542052 bytes
2024-12-23T10:53:00.857Z	7067c9e0-ff74-4bdf-a227-ec957638b13d	INFO	ffmpeg-conversion: 1.738s
2024-12-23T10:53:04.557Z	7067c9e0-ff74-4bdf-a227-ec957638b13d	INFO	whisper-api: 3.699s
2024-12-23T10:53:04.558Z	7067c9e0-ff74-4bdf-a227-ec957638b13d	INFO	srt-generation: 1.313ms
2024-12-23T10:53:04.615Z	7067c9e0-ff74-4bdf-a227-ec957638b13d	INFO	s3-upload: 56.945ms
2024-12-23T10:53:04.615Z	7067c9e0-ff74-4bdf-a227-ec957638b13d	INFO	total-execution: 5.633s
END RequestId: 7067c9e0-ff74-4bdf-a227-ec957638b13d
REPORT RequestId: 7067c9e0-ff74-4bdf-a227-ec957638b13d	Duration: 5640.67 ms	Billed Duration: 5641 ms	Memory Size: 2048 MB	Max Memory Used: 157 MB	Init Duration: 855.14 ms	
```
