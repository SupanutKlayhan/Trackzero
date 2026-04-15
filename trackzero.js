const { timeStamp } = require('console');
const express = require('express');
const path = require('path');
const port =3300;
const app = express();
app.use(express.static(path.join(__dirname, 'html')));
const router = express.Router();
router.use(express.json());
router.use(express.urlencoded({ extended: true }));
app.use(router);

router.get('/',(req,res) =>{
    console.log(`Request at: ${req.url}`);
    res.send('Hello World in plain text');
})
router.get('/Login', (req, res) => {
    console.log('Req: /Login');
    console.log('Retrieve a form');
    res.sendFile(path.join(`${__dirname}/html/Login.html`));
});

router.get('/Member', (req, res) => {
    console.log('Request at /Member');
    res.sendFile(path.join(`${__dirname}/html/Member.html`));
});
router.get('/html/Search.html', (req, res) => {
    console.log('Request at /Search');
    res.sendFile(path.join(`${__dirname}/html/Search.html`));
    
});


app.listen(port, () => {
console.log(`Server listening on port: ${port}`)
});