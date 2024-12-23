import AWS from 'aws-sdk';
import axios from 'axios';
import FormData from 'form-data';

const s3Client = new AWS.S3({
  maxRetries: 3,
  httpOptions: {
    timeout: 300000, // 5 min
    connectTimeout: 5000
  }
});

const CONFIG = {
  OPENAI_API_URL: 'https://api.openai.com/v1/audio/transcriptions',
  OPENAI_API_KEY: API_KEY,
  WHISPER_MODEL: 'whisper-1',
  BUCKET_NAME: 'autosrt'
};

const apiClient = axios.create({
  baseURL: CONFIG.OPENAI_API_URL,
  headers: {
    'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}`,
  },
  timeout: 300000, // 5 min
  maxContentLength: Infinity,
  maxBodyLength: Infinity
});

const processInChunks = async (audioFile, chunkSize = 1 * 1024 * 1024) => { // 1mb chunks
  const chunks = [];
  for (let i = 0; i < audioFile.length; i += chunkSize) {
    chunks.push(audioFile.slice(i, i + chunkSize));
  }

  const promises = chunks.map(async (chunk, index) => {
    const form = new FormData();
    form.append('file', chunk, `chunk_${index}.mp3`);
    form.append('model', CONFIG.WHISPER_MODEL);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');

    return apiClient.post('', form, {
      headers: {
        'Content-Type': `multipart/form-data; boundary=${form._boundary}`
      }
    });
  });

  return Promise.all(promises);
};

class SrtGenerator {
  static formatTime(time) {
    const seconds = Math.floor(time);
    const milliseconds = Math.round((time - seconds) * 1000);
    const minutes = Math.floor(seconds / 60);
    const formattedSeconds = seconds % 60;
    return `${this.pad(minutes)}:${this.pad(formattedSeconds)}.${this.pad(milliseconds, 3)}`;
  }

  static pad(num, length = 2) {
    return num.toString().padStart(length, '0');
  }

  static normalizeWord(word) {
    return word.replace(/[.,!?'"]/g, '').toLowerCase().trim();
  }

  static findWordMatches(textWords, apiWords) {
    const matches = [];
    let currentTextIndex = 0;
    let currentApiIndex = 0;
    let currentGroup = [];

    while (currentTextIndex < textWords.length && currentApiIndex < apiWords.length) {
      const textWord = this.normalizeWord(textWords[currentTextIndex]);
      const apiWord = this.normalizeWord(apiWords[currentApiIndex].word);
      
      if (textWord.includes(apiWord)) {
        currentGroup.push(apiWords[currentApiIndex]);
                
        const combinedApiWords = currentGroup
          .map(w => this.normalizeWord(w.word))
          .join('');
        
        if (textWord === combinedApiWords) {
          matches.push({
            textWord: textWords[currentTextIndex],
            apiWords: currentGroup,
            startTime: currentGroup[0].start,
            endTime: currentGroup[currentGroup.length - 1].end
          });
          currentGroup = [];
          currentTextIndex++;
        }
        currentApiIndex++;
      } else {
        if (currentGroup.length > 0) {
          matches.push({
            textWord: textWords[currentTextIndex],
            apiWords: currentGroup,
            startTime: currentGroup[0].start,
            endTime: currentGroup[currentGroup.length - 1].end
          });
        }
        currentGroup = [];
        currentTextIndex++;
      }
    }

    return matches;
  }

  static generate(verboseJson, wordsPerLine) {
    if (!verboseJson?.text || !verboseJson?.words) {
      throw new Error('Invalid verbose JSON format');
    }

    const textWords = verboseJson.text.trim().split(' ');
    const wordMatches = this.findWordMatches(textWords, verboseJson.words);
    
    const srtEntries = [];
    let currentEntry = {
      counter: 1,
      startTime: 0,
      words: []
    };

    wordMatches.forEach((match, i) => {
      if (currentEntry.words.length === 0) {
        currentEntry.startTime = match.startTime;
      }

      currentEntry.words.push(match.textWord);

      const isLastWord = i === wordMatches.length - 1;
      const hasEndPunctuation = match.textWord.match(/[.!?]$/);
      const reachedWordLimit = currentEntry.words.length === wordsPerLine;

      if (isLastWord || hasEndPunctuation || reachedWordLimit) {
        srtEntries.push({
          counter: currentEntry.counter,
          startTime: currentEntry.startTime,
          endTime: match.endTime,
          text: currentEntry.words.join(' ')
        });

        currentEntry = {
          counter: currentEntry.counter + 1,
          startTime: 0,
          words: []
        };
      }
    });

    return srtEntries
      .map(entry => (
        `${entry.counter}\n${this.formatTime(entry.startTime)} --> ${this.formatTime(entry.endTime)}\n${entry.text}\n\n`
      ))
      .join('');
  }
}

export const handler = async (event) => {
  try {
    console.time('total-execution');
    const { file_name: fileKey, user_id: userId, words_per_line: wordsPerLine } = event;
    
    if (!fileKey || !userId || !wordsPerLine) {
      throw new Error('Missing required parameters');
    }

    console.time('s3-fetch');
    const audioFile = await s3Client
      .getObject({ Bucket: CONFIG.BUCKET_NAME, Key: fileKey })
      .promise()
      .then(data => data.Body);
    console.timeEnd('s3-fetch');

    console.time('whisper-api');
    const chunkResponses = await processInChunks(audioFile);
    console.timeEnd('whisper-api');

    console.time('srt-generation');
    const combinedTranscription = {
      text: chunkResponses.map(res => res.data.text).join(' '),
      words: chunkResponses.flatMap(res => res.data.words)
    };

    const srtContent = SrtGenerator.generate(combinedTranscription, wordsPerLine);
    console.timeEnd('srt-generation');

    console.time('s3-upload');
    const srtFileKey = `${userId}_${fileKey.replace('.mp3', '.srt')}`;
    await s3Client
      .putObject({
        Bucket: CONFIG.BUCKET_NAME,
        Key: srtFileKey,
        Body: srtContent,
        ContentType: 'application/x-subrip',
      })
      .promise();
    console.timeEnd('s3-upload');

    console.timeEnd('total-execution');
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `SRT file successfully saved: ${srtFileKey}`
      })
    };

  } catch (error) {    
    return {
      statusCode: error.response?.status || 500,
      body: JSON.stringify({
        message: 'An error occurred during the process',
        error: error.message,
        details: error.response?.data
      })
    };
  }
};