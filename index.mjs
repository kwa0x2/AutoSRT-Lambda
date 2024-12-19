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

const processInChunks = async (audioFile, chunkSize = 2 * 1024 * 1024) => { // 2mb chunks
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

  static generate(verboseJson, wordsPerLine) {
    if (!verboseJson?.text || !verboseJson?.words) {
      throw new Error('Invalid verbose JSON format');
    }

    const wordsArray = verboseJson.text.split(' ').map(word => 
      word.replace(/^\.{3}/, '').replace(/\.{3}$/, '') 
    );
    const srtEntries = [];
    let currentEntry = {
      counter: 1,
      startTime: 0,
      words: []
    };


    wordsArray.forEach((word, i) => {
      const wordItem = verboseJson.words[i];
      
      if (currentEntry.words.length === 0) {
        currentEntry.startTime = wordItem.start;
      }

      currentEntry.words.push(word);
      
      if (currentEntry.words.length === wordsPerLine  || 
          i === wordsArray.length - 1 || 
          word.match(/[.!?]$/)) {
        
        srtEntries.push({
          counter: currentEntry.counter,
          startTime: currentEntry.startTime,
          endTime: wordItem.end,
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