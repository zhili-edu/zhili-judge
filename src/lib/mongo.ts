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
        );
        this.#dbName = name;
    }

    async connect() {
        await this.#client.connect();

        this.db = this.#client.db(this.#dbName);
        this.bucket = new GridFSBucket(this.db);

        this.problem = this.db.collection('problem');
    }

    private async getFileSize(fileId: ObjectId): Promise<number> {
        const files = await this.bucket.find({ _id: fileId }).toArray();
        if (files.length !== 1) throw new Error('Error Finding Files');
        return files[0].length;
    }

    async getTest(pid: string): Promise<Test> {
        const prob = await this.problem.findOne({
            _id: new ObjectId(pid),
        });

        if (!prob || !prob.test)
            // No TestData
            throw new Error('Can not find Problem TestData');

        return {
            subtasks: prob.test.subtasks.map((s) => ({
                ...s,
                cases: s.cases.map((c) => ({
                    ...c,
                    input: c.input.toHexString(),
                    output: c.output.toHexString(),
                })),
            })),
            limit: prob.limit,
            spj: prob.test.spj,
            interactor: prob.test.interactor,
        };
    }

    async readFileIdByLength(
        fid: string,
        lengthLimit: number,
    ): Promise<string> {
        if (!ObjectId.isValid(fid)) throw new Error('Invalid File Id');
        const fileId = new ObjectId(fid);

        const actualSize = await this.getFileSize(fileId);
        const stream = this.bucket.openDownloadStream(fileId);

        return new Promise((res, rej) => {
            stream.on('readable', () => {
                const buffer = stream.read(lengthLimit);
                if (buffer) {
                    const str = buffer.toString();
                    if (buffer.length < actualSize) {
                        const omitted = actualSize - buffer.length;
                        res(
                            `${str}
<${omitted} byte${omitted != 1 ? 's' : ''} omitted>`,
                        );
                    } else {
                        res(str);
                    }
                } else {
                    // buf is null
                    // the File is empty
                    res('');
                }
            });
        });
    }

    async copyFileTo(fid: string, path: string): Promise<void> {
        if (!ObjectId.isValid(fid)) throw new Error('Invalid File Id');
        const fileId = new ObjectId(fid);

        const readStream = this.bucket.openDownloadStream(fileId);
        const writeStream = fs.createWriteStream(path);

        return new Promise((res) => {
            readStream.on('close', res);
            readStream.pipe(writeStream);
        });
    }
}
