import {
    MongoClient,
    GridFSBucket,
    ObjectId,
    type Db,
    type GridFSBucketReadStream,
    type Collection,
} from 'mongodb';
import * as fs from 'fs';
import { Test, Limit, Executable } from '../daemon/interface/test.js';

interface RawProblem {
    limit: Limit;
    test?: {
        subtasks: {
            score: number;
            type: 'sum' | 'mul' | 'min';
            cases: {
                prefix: string;
                input: ObjectId;
                output: ObjectId;
            }[];
        }[];
        spj?: Executable;
        interactor?: Executable;
    };
}

export default class Mongo {
    #client: MongoClient;
    #dbName: string;
    db: Db;
    bucket: GridFSBucket;
    problem: Collection<RawProblem>;

    constructor(url: string, name: string, username: string, password: string) {
        this.#client = new MongoClient(
            `mongodb://${username}:${password}@${url}/${name}`,
            {
                useUnifiedTopology: true,
            },
        );
        this.#dbName = name;
    }

    async connect() {
        await this.#client.connect();

        this.db = this.#client.db(this.#dbName);
        this.bucket = new GridFSBucket(this.db);

        this.problem = this.db.collection('problem');
    }

    async getTest(pid: string): Promise<Test> {
        const prob = await this.problem.findOne({
            _id: new ObjectId(pid),
        });

        if (!prob || !prob.test)
            // No TestData
            throw new Error('Can not find Problem TestData');

        prob.test.subtasks = prob.test.subtasks.map((s) => ({
            ...s,
            cases: s.cases.map((c) => ({
                ...c,
                input: c.input,
                output: c.output,
            })),
        }));

        return { ...prob.test, limit: prob.limit };
    }

    // return a readable stream
    getFileStream(fileId: ObjectId): GridFSBucketReadStream {
        return this.bucket.openDownloadStream(fileId);
    }

    async readFileIdByLength(
        fileId: ObjectId,
        lengthLimit: number,
        appendPrompt = fileTooLongPrompt,
    ): Promise<string> {
        if (!fileId) return null;

        const actualSize = await this.getFileSize(fileId);
        const stream = this.getFileStream(fileId);

        return new Promise((res, rej) => {
            stream.on('readable', () => {
                const buffer = stream.read(lengthLimit);
                if (buffer) {
                    if (buffer.length < actualSize) {
                        res(
                            buffer.toString() +
                                '\n' +
                                appendPrompt(actualSize, buffer.length),
                        );
                    } else {
                        res(buffer.toString());
                    }
                } else {
                    rej(new Error('Can not read from file'));
                }
            });
        });
    }

    async getFileSize(fileId: ObjectId): Promise<number> {
        const files = await this.bucket.find({ _id: fileId }).toArray();
        if (files.length !== 1) throw new Error('Error Finding Files');
        return files[0].length;
    }

    async copyFileTo(fileId: ObjectId, path: string): Promise<void> {
        const readStream = this.getFileStream(fileId);
        const writeStream = fs.createWriteStream(path);

        readStream.pipe(writeStream);
        return new Promise((fullfilled) => {
            readStream.on('close', fullfilled);
        });
    }
}

function fileTooLongPrompt(actualSize: number, bytesRead: number): string {
    const omitted = actualSize - bytesRead;
    return `<${omitted} byte${omitted != 1 ? 's' : ''} omitted>`;
}
