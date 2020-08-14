const multiparty = require("multiparty");
const path = require("path");
const fse = require("fs-extra");
// 提取后缀名的方法
const extractExt = filename =>{
  return filename.slice(filename.lastIndexOf("."), filename.length); // 提取后缀名
}
// 开辟一个大文件存储目录
const UPLOAD_DIR = path.resolve(__dirname, ".", "target"); // 大文件存储目录

// 文件流操作
const pipeStream = (path, writeStream) => {
    return new Promise(resolve => {
        // 创建一个可读流
        const readStream = fse.createReadStream(path);

        readStream.on("end", () => {
          // 写入后删除所有blob文件
          fse.unlinkSync(path);
          resolve();
        });
        readStream.pipe(writeStream);
    });
}
  

// 合并切片
const mergeFileChunk = async (filePath, fileHash, size) => {
  try{
    const chunkDir = path.resolve(UPLOAD_DIR, fileHash);
    // 读取上传给后台的chunk文件下有多少个blob文件块，并且拿到其下所有的blob快的文件名
    const chunkPaths = await fse.readdir(chunkDir);
    // 根据切片下标进行排序
    // 否则直接读取目录的获得的顺序可能会错乱
    chunkPaths.length>1&&chunkPaths.sort((a, b) => a.split("-")[1] - b.split("-")[1]);
    // 保证每一个切片都通过pipeStream提供的bridge（或者说管道pipe）方法完成文件合并的文件流操作
    await Promise.all(
      chunkPaths.map((chunkPath, index) =>
        pipeStream(
          // 找到每个chunk所在的文件位置
          path.resolve(chunkDir, chunkPath),
          // 指定位置创建可写流
          fse.createWriteStream(filePath, {
            start: index * size,
            end: (index + 1) * size
          })
        )
      )
    );
    // 这一步是流操作完后合并后删除保存切片的目录
    fse.rmdirSync(chunkDir); // 合并后删除保存切片的目录
  }catch(error){
    console.log('merg err@@@@@@@@@@',error)
    throw(error)
  }
};

// 对上传到node的数据进行数据整形方便后续操作
const resolvePost = req => {
    return new Promise(resolve => {
        let chunk = "";
        req.on("data", data => {
          chunk += data;
        });
        req.on("end", () => {
          resolve(JSON.parse(chunk));
        });
    });
}
  

// 返回已经上传切片名
const createUploadedList = async fileHash => {
    return fse.existsSync(path.resolve(UPLOAD_DIR, fileHash))
    ? await fse.readdir(path.resolve(UPLOAD_DIR, fileHash))
    : [];
}
  

module.exports = class {
  // 合并切片
  async handleMerge(req, res) {
    try{
      const data = await resolvePost(req);
      const { fileHash, filename, size } = data;
      const ext = extractExt(filename);
      const filePath = path.resolve(UPLOAD_DIR, `${fileHash}${ext}`);
      await mergeFileChunk(filePath, fileHash, size);
      res.end(
        JSON.stringify({
          code: 200,
          message: "file merged success"
        })
      );
    }catch(err){
      res.end(
        JSON.stringify({
          code: 500,
          message: err
        })
      );
    }
  }



  // 处理切片
  async handleFormData(req, res) {
    const multipart = new multiparty.Form();
    multipart.parse(req, async (err, fields, files) => {
      if (err) {
        console.error(err);
        res.status = 500;
        res.end("process file chunk failed");
        return;
      }
      const [chunk] = files.chunk;
      const [hash] = fields.hash;
      const [fileHash] = fields.fileHash;//文件hash
      const [filename] = fields.filename;//文件名
      const filePath = path.resolve(
        UPLOAD_DIR,
        `${fileHash}${extractExt(filename)}`
      );
      const chunkDir = path.resolve(UPLOAD_DIR, fileHash);

      // 文件存在直接返回
      if (fse.existsSync(filePath)) {
        return res.end("file exist");
      }

      // 切片目录不存在，创建切片目录，防止多次请求多次创建文件
      if (!fse.existsSync(chunkDir)) {
        await fse.mkdirs(chunkDir);
      }
      // fs-extra 专用方法，类似 fs.rename 并且跨平台
      // fs-extra 的 rename 方法 windows 平台会有权限问题
      // https://github.com/meteor/meteor/issues/7852#issuecomment-255767835
      // 将上传的blob文件组放到指定目录下的同名文件夹内
      await fse.move(chunk.path, path.resolve(chunkDir, hash));
      res.end("received file chunk");
    });
  }
  // 验证是否已上传/已上传切片下标
  async handleVerifyUpload(req, res) {
    const data = await resolvePost(req);
    const { fileHash, filename } = data;
    const ext = extractExt(filename);
    const filePath = path.resolve(UPLOAD_DIR, `${fileHash}${ext}`);
    // console.log(filePath,fse.existsSync(filePath))
    if (fse.existsSync(filePath)) {
      res.end(
        JSON.stringify({
          shouldUpload: false
        })
      );
    } else {
      res.end(
        JSON.stringify({
          shouldUpload: true,
          uploadedList: await createUploadedList(fileHash)
        })
      );
    }
  }
};
