// Derived from Apache OpenDAL opendal-service-ftp 0.59.5 (Apache-2.0); changed by Shetu, see CHANGES.md
// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

use std::vec::IntoIter;

use super::listing::Entry;
use opendal::raw::*;
use opendal::*;

pub struct FtpLister {
    path: String,
    file_iter: IntoIter<Entry>,
}

impl FtpLister {
    pub fn new(path: &str, files: Vec<Entry>) -> Self {
        Self {
            path: path.to_string(),
            file_iter: files.into_iter(),
        }
    }
}

impl oio::List for FtpLister {
    async fn next(&mut self) -> Result<Option<oio::Entry>> {
        let Some(de) = self.file_iter.next() else {
            return Ok(None);
        };
        let path = self.path.to_string() + &de.name;
        let mut meta = if de.dir {
            MetadataBuilder::dir()
        } else {
            MetadataBuilder::file(de.size)
        };
        meta.last_modified(Timestamp::try_from(de.modified)?);
        Ok(Some(if de.dir {
            oio::Entry::new(&format!("{path}/"), meta.build())
        } else {
            oio::Entry::new(&path, meta.build())
        }))
    }
}
